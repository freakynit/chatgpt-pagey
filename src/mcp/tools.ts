import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { Connection, Store } from "../auth/store.js";
import { PageyApiError, type PageyClient } from "../pagey/client.js";
import {
  buildSite,
  formatBytes,
  SiteInputError,
  validateExpiry,
  validatePassword,
  validateSubdomain,
  type SiteFileInput,
} from "../pagey/site-input.js";
import type {
  Analytics,
  CountryRestriction,
  FormDefinitionInput,
  FormFieldType,
  PageyForm,
  PageySite,
} from "../pagey/types.js";
import type { Logger } from "../util/logger.js";

export interface ToolContext {
  config: Config;
  store: Store;
  connection: Connection;
  pagey: PageyClient;
  log: Logger;
}

class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SUBDOMAIN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const siteRefDescription =
  "Site ID, subdomain, full pagey.site URL, or exact title. Omit to use the most recently published site for this Pagey account.";

const fileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Relative path from the site root, for example index.html or assets/hero.png."),
  content: z
    .string()
    .describe("UTF-8 file text, or base64 data when encoding is set to base64."),
  encoding: z
    .enum(["utf8", "base64"])
    .optional()
    .describe("Use utf8 (default) for text and base64 for binary assets such as images or fonts."),
});

function siteInputSchema() {
  return {
    files: z
      .array(fileInputSchema)
      .max(1000)
      .optional()
      .describe("Files for a multi-file site. Must include index.html at the root."),
    html: z
      .string()
      .optional()
      .describe("Complete HTML for index.html. Use this for a single-file site; inline CSS and JavaScript."),
  };
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "publish_site",
    {
      title: "Publish a new site to Pagey",
      description:
        "Create a new free static site on Pagey from HTML written in the conversation. Use this when the user asks to publish, deploy, host, or share a NEW static website. Pass html for a single-page site, or files with index.html plus assets for a multi-file site. Returns a live https://<subdomain>.pagey.site URL. Creating a site uses the account's 25-per-day new-site allowance. To change an existing site, use update_site instead of creating another site.",
      inputSchema: {
        ...siteInputSchema(),
        title: z.string().max(255).optional().describe("Short human-readable site title, for example 'Acme landing page'."),
        subdomain: z
          .string()
          .optional()
          .describe("Optional requested subdomain (lowercase letters, numbers, hyphens; max 63). Becomes the live URL."),
        password: z
          .string()
          .min(6)
          .max(200)
          .optional()
          .describe("Optional site password (6+ characters). Visitors must enter it to view the site."),
        expires_at: z
          .string()
          .optional()
          .describe("Optional ISO 8601 date-time after which the site expires, for example 2026-12-31T23:59:00Z."),
      },
      annotations: {
        title: "Publish a new site",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Publishing to Pagey…",
        "openai/toolInvocation/invoked": "Published to Pagey.",
      },
    },
    async (args) =>
      runTool("publish_site", ctx, async () => {
        const built = buildSite(
          { html: args.html, files: args.files as SiteFileInput[] | undefined },
          { maxFiles: ctx.config.maxFiles, maxBytes: ctx.config.maxUploadBytes },
        );
        const title = normalizeOptionalTitle(args.title);
        const subdomain = args.subdomain ? validateSubdomain(args.subdomain) : undefined;
        const password = args.password ? validatePassword(args.password) : undefined;
        const expiresAt = args.expires_at ? validateExpiry(args.expires_at) : undefined;

        const site = await ctx.pagey.createSite({
          zip: built.zip,
          title,
          subdomain,
          password,
          expiresAt,
        });
        ctx.connection.lastSiteId = site.id;
        ctx.store.setLastSite(ctx.connection.id, site.id);

        const summary = siteSummary(site, ctx);
        const heading = siteHeading(site);
        const text = [
          `Published “${heading}” to ${summary.url}`,
          `Site ID: ${site.id} · ${built.files.length} ${plural(built.files.length, "file")} · ${formatBytes(built.totalBytes)}`,
          "",
          `To change it later, call update_site with site "${site.id}". The URL stays the same.`,
        ].join("\n");
        return ok(text, {
          ...summary,
          files: built.files,
          total_bytes: built.totalBytes,
          created: true,
        });
      }),
  );

  server.registerTool(
    "update_site",
    {
      title: "Update an existing Pagey site",
      description:
        "Replace the complete content of an existing Pagey site while keeping its URL. Use this whenever the user asks to change, rebuild, redeploy, or update a site that already exists; do not publish a duplicate. Old files are removed, not merged. Pass html for a single file, or files with index.html plus assets. If the site is not specified, the most recently published site is used.",
      inputSchema: {
        site: z.string().optional().describe(siteRefDescription),
        ...siteInputSchema(),
        title: z.string().max(255).optional().describe("Optional new title for the site. An empty string clears it."),
      },
      annotations: {
        title: "Update a site",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Updating the Pagey site…",
        "openai/toolInvocation/invoked": "Pagey site updated.",
      },
    },
    async (args) =>
      runTool("update_site", ctx, async () => {
        if (!args.html && !args.files?.length) {
          throw new ToolError("Provide html or files to replace the site content. Use update_site_settings for metadata-only changes.");
        }
        const site = await resolveSite(ctx, args.site);
        const built = buildSite(
          { html: args.html, files: args.files as SiteFileInput[] | undefined },
          { maxFiles: ctx.config.maxFiles, maxBytes: ctx.config.maxUploadBytes },
        );

        let updated = await ctx.pagey.replaceContent(site.id, built.zip);
        let titleWarning: string | undefined;
        if (args.title !== undefined) {
          try {
            updated = await ctx.pagey.updateSite(site.id, { title: normalizeTitleOrNull(args.title) });
          } catch (error) {
            titleWarning =
              error instanceof PageyApiError
                ? `The content was updated, but the title could not be changed: ${error.message}`
                : "The content was updated, but the title could not be changed.";
          }
        }

        ctx.connection.lastSiteId = updated.id;
        ctx.store.setLastSite(ctx.connection.id, updated.id);

        const summary = siteSummary(updated, ctx);
        const text = [
          `Updated “${siteHeading(updated)}” at ${summary.url}`,
          `Site ID: ${updated.id} · ${built.files.length} ${plural(built.files.length, "file")} · ${formatBytes(built.totalBytes)}`,
          titleWarning ? `\n${titleWarning}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return ok(text, {
          ...summary,
          files: built.files,
          total_bytes: built.totalBytes,
          updated: true,
        });
      }),
  );

  server.registerTool(
    "list_sites",
    {
      title: "List Pagey sites",
      description:
        "List sites in the connected Pagey account, with their live URLs and IDs. Use this to find a site before updating it, to check whether a publish already succeeded, or when the user asks what sites they have. Defaults to active sites, newest first.",
      inputSchema: {
        search: z.string().max(200).optional().describe("Filter by subdomain or title, case-insensitive substring."),
        status: z
          .enum(["active", "deleted", "expired"])
          .optional()
          .describe("Filter by status. Defaults to active."),
        page: z.number().int().min(1).max(1_000_000).optional().describe("Page number, starting at 1."),
        page_size: z.number().int().min(1).max(100).optional().describe("Results per page, default 20, max 100."),
      },
      annotations: {
        title: "List sites",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Loading Pagey sites…",
        "openai/toolInvocation/invoked": "Pagey sites loaded.",
      },
    },
    async (args) =>
      runTool("list_sites", ctx, async () => {
        const page = args.page ?? 1;
        const pageSize = args.page_size ?? 20;
        const status = args.status ?? "active";
        const data = await ctx.pagey.listSites({ page, pageSize, status, search: args.search });
        const items = data.items.map((site) => siteSummary(site, ctx));
        const hasMore = page * pageSize < data.total;

        let text: string;
        if (data.total === 0) {
          text = args.search
            ? `No ${status} sites match “${args.search}”.`
            : `No ${status} sites found in this Pagey account.`;
        } else {
          const start = (page - 1) * pageSize + 1;
          const end = Math.min(page * pageSize, data.total);
          const lines = data.items.map((site) => {
            const flags = siteFlags(site);
            return `- ${siteHeading(site)} — ${ctx.pagey.siteUrl(site.subdomain)}${flags ? ` (${flags})` : ""}\n  ID: ${site.id}`;
          });
          text = [
            `Showing ${start}–${end} of ${data.total} ${status} ${plural(data.total, "site")}${args.search ? ` matching “${args.search}”` : ""}.`,
            ...lines,
          ].join("\n");
          if (hasMore) text += `\n\nMore results are available. Call list_sites with page ${page + 1}.`;
        }

        return ok(text, {
          items,
          page,
          page_size: pageSize,
          total: data.total,
          has_more: hasMore,
        });
      }),
  );

  server.registerTool(
    "get_site",
    {
      title: "Get a Pagey site",
      description:
        "Get the URL, title, status, expiry, password protection, maintenance mode, tags, and timestamps for one site. Use this after a publish to confirm the live URL, or when the user asks for a site's details.",
      inputSchema: {
        site: z.string().optional().describe(siteRefDescription),
      },
      annotations: {
        title: "Get site details",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool("get_site", ctx, async () => {
        const site = await resolveSite(ctx, args.site);
        const summary = siteSummary(site, ctx);
        const flags = siteFlags(site);
        const text = [
          `“${siteHeading(site)}”`,
          `${summary.url}`,
          `Site ID: ${site.id}`,
          `Status: ${site.status}${flags ? ` · ${flags}` : ""}`,
          site.expiresAt ? `Expires: ${site.expiresAt}` : "No expiry",
          `Tags: ${site.tags?.length ? site.tags.join(", ") : "none"}`,
        ].join("\n");
        return ok(text, summary);
      }),
  );

  server.registerTool(
    "update_site_settings",
    {
      title: "Update Pagey site settings",
      description:
        "Change metadata for an existing site without replacing its content: title, password protection, expiry, custom subdomain, maintenance mode, tags, or country restrictions. Use this for requests like 'rename my site', 'password-protect it', 'make it expire Friday', 'put it in maintenance mode', or 'only allow visitors from India'. Changing the subdomain immediately breaks the old URL, so only do that when the user explicitly asks.",
      inputSchema: {
        site: z.string().optional().describe(siteRefDescription),
        title: z.string().max(255).optional().describe("New site title. An empty string clears the title."),
        password: z.string().min(6).max(200).optional().describe("New site password (6+ characters)."),
        clear_password: z.boolean().optional().describe("Remove password protection. Do not combine with password."),
        expires_at: z.string().optional().describe("New ISO 8601 expiry date-time. Must be in the future."),
        clear_expiry: z.boolean().optional().describe("Remove the expiry. Do not combine with expires_at."),
        subdomain: z
          .string()
          .optional()
          .describe("New custom subdomain. The old URL stops working immediately."),
        maintenance: z.boolean().optional().describe("Enable or disable maintenance mode."),
        tags: z.array(z.string()).max(5).optional().describe("Replace all site tags. Max 5 tags, 30 characters each. Pass [] to remove."),
        country_restriction: z
          .object({
            mode: z.enum(["off", "allow", "block"]).describe("off, allow only listed countries, or block listed countries."),
            countries: z.array(z.string()).max(250).describe("Two-letter ISO country codes, for example IN, US, GB."),
          })
          .optional()
          .describe("Complete country restriction rule."),
      },
      annotations: {
        title: "Update site settings",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool("update_site_settings", ctx, async () => {
        let site = await resolveSite(ctx, args.site);
        const changed: string[] = [];

        const patch: {
          title?: string | null;
          password?: string | null;
          expiresAt?: string | null;
          countryRestriction?: CountryRestriction;
        } = {};

        if (args.title !== undefined) {
          patch.title = normalizeTitleOrNull(args.title);
          changed.push("title");
        }
        if (args.password !== undefined && args.clear_password) {
          throw new ToolError("Use either password or clear_password, not both.");
        }
        if (args.clear_password) {
          patch.password = null;
          changed.push("password");
        } else if (args.password !== undefined) {
          patch.password = validatePassword(args.password);
          changed.push("password");
        }
        if (args.expires_at !== undefined && args.clear_expiry) {
          throw new ToolError("Use either expires_at or clear_expiry, not both.");
        }
        if (args.clear_expiry) {
          patch.expiresAt = null;
          changed.push("expiry");
        } else if (args.expires_at !== undefined) {
          patch.expiresAt = validateExpiry(args.expires_at);
          changed.push("expiry");
        }
        if (args.country_restriction !== undefined) {
          patch.countryRestriction = normalizeCountryRestriction(args.country_restriction);
          changed.push("country_restriction");
        }

        if (Object.keys(patch).length > 0) {
          site = await ctx.pagey.updateSite(site.id, patch);
        }

        if (args.subdomain !== undefined) {
          const next = validateSubdomain(args.subdomain);
          if (next !== site.subdomain) {
            site = await ctx.pagey.setSubdomain(site.id, next);
            changed.push("subdomain");
          }
        }
        if (args.maintenance !== undefined) {
          site = await ctx.pagey.setMaintenance(site.id, args.maintenance);
          changed.push("maintenance");
        }
        if (args.tags !== undefined) {
          const tags = normalizeTags(args.tags);
          site = await ctx.pagey.setTags(site.id, tags);
          changed.push("tags");
        }

        const summary = siteSummary(site, ctx);
        if (changed.length === 0) {
          return ok(`No changes were requested for “${siteHeading(site)}”.`, summary);
        }
        const text = [
          `Updated ${changed.join(", ")} for “${siteHeading(site)}”.`,
          `URL: ${summary.url}`,
          changed.includes("subdomain")
            ? "The previous subdomain no longer works."
            : "The site URL is unchanged.",
        ].join("\n");
        return ok(text, { ...summary, changed });
      }),
  );

  server.registerTool(
    "delete_site",
    {
      title: "Delete a Pagey site",
      description:
        "Permanently delete a site from Pagey. Deletion is one-way; the site cannot be restored and its URL stops serving. Only call this after the user has explicitly confirmed deletion in this conversation. Requires confirm: true.",
      inputSchema: {
        site: z.string().describe(siteRefDescription),
        confirm: z
          .boolean()
          .describe("Must be true. Set this only after the user explicitly confirmed the deletion."),
      },
      annotations: {
        title: "Delete a site",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool("delete_site", ctx, async () => {
        if (!args.confirm) {
          throw new ToolError("Not deleted. Ask the user to confirm the deletion, then call delete_site again with confirm: true.");
        }
        const site = await resolveSite(ctx, args.site);
        const url = ctx.pagey.siteUrl(site.subdomain);
        await ctx.pagey.deleteSite(site.id);
        ctx.store.clearLastSite(ctx.connection.id, site.id);
        if (ctx.connection.lastSiteId === site.id) ctx.connection.lastSiteId = null;
        return ok(`Deleted “${siteHeading(site)}”. ${url} no longer serves this site.`, {
          site_id: site.id,
          subdomain: site.subdomain,
          url,
          deleted: true,
        });
      }),
  );

  server.registerTool(
    "get_site_analytics",
    {
      title: "Get Pagey site analytics",
      description:
        "Read visitor analytics for a site: page views, unique visitors, sessions, top pages, referrers, countries, devices, browsers, and traffic sources. Use when the user asks how many people visited, where traffic came from, or which pages are popular. Pagey keeps 90 days of analytics.",
      inputSchema: {
        site: z.string().optional().describe(siteRefDescription),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Number of days to report, from 1 to 90. Defaults to 7."),
      },
      annotations: {
        title: "Get site analytics",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool("get_site_analytics", ctx, async () => {
        const site = await resolveSite(ctx, args.site);
        const days = args.days ?? 7;
        const to = new Date();
        const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
        const analytics = await ctx.pagey.getAnalytics(site.id, from, to);

        const summary = siteSummary(site, ctx);
        const structured = {
          site: summary,
          period: { from: analytics.from, to: analytics.to, days },
          page_views: analytics.pageViews,
          unique_visitors: analytics.uniqueVisitors,
          sessions: analytics.sessions,
          daily: analytics.daily,
          top_pages: analytics.topPages.slice(0, 10),
          referrers: analytics.referrers.slice(0, 10),
          countries: analytics.countries.slice(0, 10),
          devices: analytics.devices.slice(0, 10),
          browsers: analytics.browsers.slice(0, 10),
          traffic_sources: analytics.trafficSources.slice(0, 10),
        };

        if (analytics.pageViews === 0 && analytics.uniqueVisitors === 0) {
          return ok(
            `No visits recorded for “${siteHeading(site)}” in the last ${days} ${plural(days, "day")}. New sites can take a moment to record their first view.`,
            structured,
          );
        }

        const lines = [
          `Analytics for “${siteHeading(site)}” (last ${days} ${plural(days, "day")}):`,
          `${formatNumber(analytics.pageViews)} page ${plural(analytics.pageViews, "view")} · ${formatNumber(analytics.uniqueVisitors)} unique ${plural(analytics.uniqueVisitors, "visitor")} · ${formatNumber(analytics.sessions)} ${plural(analytics.sessions, "session")}`,
        ];
        if (analytics.topPages.length > 0) {
          lines.push(
            `Top pages: ${analytics.topPages
              .slice(0, 5)
              .map((page) => `${page.path} (${formatNumber(page.pageViews)})`)
              .join(", ")}`,
          );
        }
        if (analytics.referrers.length > 0) {
          lines.push(
            `Top referrers: ${analytics.referrers
              .slice(0, 5)
              .map((item) => `${item.referrer || "direct"} (${formatNumber(item.count)})`)
              .join(", ")}`,
          );
        }
        if (analytics.countries.length > 0) {
          lines.push(
            `Countries: ${analytics.countries
              .slice(0, 5)
              .map((item) => `${item.countryCode} (${formatNumber(item.count)})`)
              .join(", ")}`,
          );
        }
        return ok(lines.join("\n"), structured);
      }),
  );

  server.registerTool(
    "create_form",
    {
      title: "Create a Pagey form",
      description:
        "Create a hosted contact, waitlist, feedback, or survey form on Pagey, including its backend for storing submissions. Use this when the user wants a working form rather than a decorative HTML form. After creating it, embed the returned iframe snippet in the site HTML and publish or update the site. Free accounts can have 25 active forms and 5,000 submissions per calendar month.",
      inputSchema: {
        title: z.string().min(1).max(255).describe("Form title, shown to visitors."),
        description: z.string().max(1000).optional().describe("Optional short description shown above the fields."),
        fields: z
          .array(
            z.object({
              name: z
                .string()
                .regex(/^[a-z][a-z0-9_]*$/u)
                .max(64)
                .describe("Field key, lowercase letters, numbers, and underscores. Must start with a letter."),
              label: z.string().min(1).max(150).describe("Label shown to visitors."),
              type: z
                .enum(["text", "email", "tel", "textarea", "number", "date", "url", "select", "radio", "checkbox"])
                .describe("Input type."),
              required: z.boolean().optional().describe("Whether visitors must fill this field."),
              placeholder: z.string().max(200).optional().describe("Optional placeholder text."),
              options: z
                .array(z.string().min(1).max(150))
                .min(1)
                .max(50)
                .optional()
                .describe("Choices for select and radio fields. Required for those types."),
            }),
          )
          .min(1)
          .max(25)
          .describe("Form fields in display order, up to 25."),
        settings: z
          .object({
            acceptingResponses: z.boolean().optional().describe("Whether the form accepts new responses. Default true."),
            allowResubmit: z.boolean().optional().describe("Whether the same email can submit more than once. Default true."),
            submitLabel: z.string().min(1).max(60).optional().describe("Submit button text. Default 'Send message'."),
            successMessage: z.string().min(1).max(1000).optional().describe("Message shown after submission."),
          })
          .optional(),
        styles: z
          .object({
            background: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
            text: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
            accent: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
            buttonText: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
            font: z.enum(["sans", "serif", "mono"]).optional(),
            radius: z.number().int().min(0).max(24).optional(),
            width: z.number().int().min(280).max(900).optional(),
          })
          .optional(),
      },
      annotations: {
        title: "Create a form",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Creating the Pagey form…",
        "openai/toolInvocation/invoked": "Pagey form created.",
      },
    },
    async (args) =>
      runTool("create_form", ctx, async () => {
        validateFormFields(args.fields);
        if (args.title.trim() === "") throw new ToolError("Form title cannot be empty.");
        const input: FormDefinitionInput = {
          title: args.title.trim(),
          fields: args.fields.map((field) => ({
            name: field.name,
            label: field.label.trim(),
            type: field.type as FormFieldType,
            required: field.required,
            placeholder: field.placeholder,
            options: field.options,
          })),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.settings !== undefined ? { settings: args.settings } : {}),
          ...(args.styles !== undefined ? { styles: args.styles } : {}),
        };
        const form = await ctx.pagey.createForm(input);
        const origin = new URL(ctx.config.pageyApiUrl).origin;
        const embedUrl = `${origin}/api/public/forms/${form.id}/embed`;
        const submitUrl = `${origin}/api/public/forms/${form.id}/submit`;
        const iframe = `<iframe src="${embedUrl}" title="${escapeAttribute(args.title.trim())}" width="100%" height="600" style="border:0;max-width:100%"></iframe>`;
        const text = [
          `Created form “${args.title.trim()}”.`,
          `Form ID: ${form.id}`,
          "",
          "Embed it in the site HTML with:",
          iframe,
          "",
          `Responses are stored by Pagey. Read them with get_form_responses using form_id "${form.id}".`,
        ].join("\n");
        return ok(text, {
          form_id: form.id,
          title: args.title.trim(),
          embed_url: embedUrl,
          submit_url: submitUrl,
          iframe,
          dashboard_url: `${origin}/dashboard/forms`,
          field_count: args.fields.length,
        });
      }),
  );

  server.registerTool(
    "list_forms",
    {
      title: "List Pagey forms",
      description:
        "List the forms in the connected Pagey account with their response counts and linked sites. Use when the user asks which forms exist or wants a form ID before reading responses.",
      inputSchema: {
        site_id: z.string().optional().describe("Optional Pagey site ID to show only forms linked to that site."),
        page: z.number().int().min(1).max(1_000_000).optional(),
        page_size: z.number().int().min(1).max(100).optional().describe("Results per page, default 20, max 100."),
      },
      annotations: {
        title: "List forms",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool("list_forms", ctx, async () => {
        const page = args.page ?? 1;
        const pageSize = args.page_size ?? 20;
        const data = await ctx.pagey.listForms({ siteId: args.site_id, page, pageSize });
        const items = data.items.map((form) => formSummary(form));
        if (data.total === 0) {
          return ok("No forms found in this Pagey account.", { items, page, page_size: pageSize, total: 0 });
        }
        const lines = data.items.map(
          (form) =>
            `- ${form.title ?? "(untitled)"} — ${formatNumber(form.responseCount ?? 0)} ${plural(form.responseCount ?? 0, "response")}${form.siteSubdomain ? ` · on ${form.siteSubdomain}.pagey.site` : ""}\n  ID: ${form.id}`,
        );
        return ok(
          [`Showing ${data.items.length} of ${data.total} ${plural(data.total, "form")}.`, ...lines].join("\n"),
          { items, page, page_size: pageSize, total: data.total },
        );
      }),
  );

  server.registerTool(
    "get_form_responses",
    {
      title: "Read Pagey form responses",
      description:
        "Read submissions for a Pagey-hosted form, newest first. Use when the user asks who submitted a form, wants the latest entries, or needs to search responses by email, name, phone, or text.",
      inputSchema: {
        form_id: z.string().describe("The form ID returned by create_form or list_forms."),
        search: z.string().max(200).optional().describe("Optional case-insensitive search across email, name, phone, and text fields."),
        page: z.number().int().min(1).max(1_000_000).optional(),
        page_size: z.number().int().min(1).max(100).optional().describe("Responses per page, default 20, max 100."),
      },
      annotations: {
        title: "Read form responses",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool("get_form_responses", ctx, async () => {
        const page = args.page ?? 1;
        const pageSize = args.page_size ?? 20;
        const data = await ctx.pagey.getFormResponses(args.form_id, {
          page,
          pageSize,
          search: args.search,
        });
        const items = data.items.map((response) => ({
          id: response.id,
          submitted_at: response.submittedAt,
          email: response.email,
          first_name: response.firstName,
          last_name: response.lastName,
          full_name: response.fullName,
          phone: response.phone,
          input_text: response.inputText,
          extra_fields: response.extraFields,
        }));
        if (data.total === 0) {
          return ok(
            args.search
              ? `No responses match “${args.search}” for “${data.form.title ?? "this form"}”.`
              : `No responses yet for “${data.form.title ?? "this form"}”.`,
            { form_id: data.form.id, form_title: data.form.title, total: 0, items, page, page_size: pageSize },
          );
        }
        const lines = data.items.slice(0, 10).map((response) => {
          const fullName = [response.firstName, response.lastName].filter(Boolean).join(" ");
          const who =
            [response.fullName, fullName, response.email, response.phone].find((value) => Boolean(value && value.trim())) ??
            "Anonymous";
          const message = response.inputText ? ` — ${truncate(response.inputText, 120)}` : "";
          return `- ${response.submittedAt.slice(0, 10)} · ${who}${response.email && who !== response.email ? ` <${response.email}>` : ""}${message}`;
        });
        return ok(
          [
            `${formatNumber(data.total)} ${plural(data.total, "response")} for “${data.form.title ?? "form"}”${args.search ? ` matching “${args.search}”` : ""}.`,
            ...lines,
            data.total > 10 ? `\nShowing the first 10. Use page/page_size to read more.` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          {
            form_id: data.form.id,
            form_title: data.form.title,
            total: data.total,
            page,
            page_size: pageSize,
            items,
          },
        );
      }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Check the Pagey connection",
      description:
        "Show which Pagey account is connected, its tier, and how many sites it owns. Use this to confirm the connection or diagnose an authentication problem before publishing.",
      inputSchema: {},
      annotations: {
        title: "Check Pagey account",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      runTool("whoami", ctx, async () => {
        const user = await ctx.pagey.me();
        const sites = await ctx.pagey.listSites({ page: 1, pageSize: 1 });
        const text = [
          `Connected to Pagey as ${user.email} (${user.tier} tier).`,
          `${formatNumber(sites.total)} ${plural(sites.total, "site")} in this account.`,
        ].join("\n");
        return ok(text, {
          email: user.email,
          tier: user.tier,
          user_id: user.id,
          email_verified: user.isEmailVerified,
          sites_total: sites.total,
        });
      }),
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolveSite(ctx: ToolContext, reference?: string): Promise<PageySite> {
  const raw = reference?.trim();
  if (!raw) {
    if (ctx.connection.lastSiteId) return ctx.pagey.getSite(ctx.connection.lastSiteId);
    throw new ToolError(
      "No site specified and this Pagey account has not published a site yet. Call list_sites to choose one.",
    );
  }

  let candidate = raw;
  const suffix = `.${ctx.config.pageySiteDomain.toLowerCase()}`;
  if (/^https?:\/\//iu.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ToolError(`“${raw}” is not a valid URL.`);
    }
    if (!url.hostname.toLowerCase().endsWith(suffix)) {
      throw new ToolError(`Expected a ${ctx.config.pageySiteDomain} URL, for example https://my-site.${ctx.config.pageySiteDomain}.`);
    }
    candidate = url.hostname.slice(0, -suffix.length);
  } else if (raw.toLowerCase().endsWith(suffix)) {
    candidate = raw.slice(0, -suffix.length);
  }

  if (UUID_RE.test(candidate)) return ctx.pagey.getSite(candidate);

  const lowered = candidate.toLowerCase();
  if (SUBDOMAIN_RE.test(lowered) && lowered.length <= 63) {
    const exact = await ctx.pagey.listSites({ search: lowered, pageSize: 100, status: "active" });
    const match = exact.items.find((site) => site.subdomain.toLowerCase() === lowered);
    if (match) return match;
  }

  const matches = await ctx.pagey.listSites({ search: candidate, pageSize: 20, status: "active" });
  const normalizedCandidate = normalizeForTitle(candidate);
  const exactTitle = matches.items.filter((site) => normalizeForTitle(site.title ?? "") === normalizedCandidate);
  if (exactTitle.length === 1) return exactTitle[0] as PageySite;
  if (exactTitle.length > 1) {
    const choices = exactTitle
      .slice(0, 8)
      .map((site) => `${site.title ?? site.subdomain} (${site.subdomain}, ID ${site.id})`)
      .join("; ");
    throw new ToolError(`Multiple sites have the title “${candidate}”: ${choices}. Pass the exact site ID or subdomain.`);
  }
  if (matches.items.length > 0) {
    const choices = matches.items
      .slice(0, 8)
      .map((site) => `${site.title ?? site.subdomain} (${site.subdomain}, ID ${site.id})`)
      .join("; ");
    throw new ToolError(
      `No exact match for “${candidate}”. Did you mean one of these? ${choices}. Pass the exact site ID, subdomain, or title.`,
    );
  }
  throw new ToolError(`No active Pagey site matches “${candidate}”. Call list_sites to see your sites.`);
}

function siteSummary(site: PageySite, ctx: ToolContext): Record<string, unknown> {
  return {
    site_id: site.id,
    url: ctx.pagey.siteUrl(site.subdomain),
    subdomain: site.subdomain,
    title: site.title ?? null,
    status: site.status,
    password_protected: Boolean(site.isPasswordProtected),
    maintenance_mode: Boolean(site.maintenanceMode),
    expires_at: site.expiresAt ?? null,
    tags: site.tags ?? [],
    country_restriction: site.countryRestriction ?? null,
    content_revision: site.contentRevision ?? null,
    created_at: site.createdAt,
    updated_at: site.updatedAt,
    last_published_at: site.lastPublishedAt ?? null,
  };
}

function siteHeading(site: PageySite): string {
  return site.title?.trim() || site.subdomain;
}

function siteFlags(site: PageySite): string {
  return [
    site.isPasswordProtected ? "password-protected" : "",
    site.maintenanceMode ? "maintenance mode" : "",
    site.expiresAt ? `expires ${site.expiresAt.slice(0, 10)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function formSummary(form: PageyForm): Record<string, unknown> {
  return {
    form_id: form.id,
    title: form.title,
    status: form.status,
    response_count: form.responseCount ?? null,
    site_subdomain: form.siteSubdomain ?? null,
    site_title: form.siteTitle ?? null,
    created_at: form.createdAt,
  };
}

function normalizeOptionalTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const title = value.replace(/\s+/gu, " ").trim();
  if (title === "") return undefined;
  if (title.length > 255) throw new ToolError("Site title must be 255 characters or fewer.");
  return title;
}

function normalizeTitleOrNull(value: string): string | null {
  const title = value.replace(/\s+/gu, " ").trim();
  if (title === "") return null;
  if (title.length > 255) throw new ToolError("Site title must be 255 characters or fewer.");
  return title;
}

function normalizeTags(values: string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    const tag = value.trim();
    if (!tag) continue;
    if (tag.length > 30) throw new ToolError("Each tag must be 30 characters or fewer.");
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > 5) throw new ToolError("A site can have at most 5 tags.");
  return tags;
}

function normalizeCountryRestriction(input: { mode: "off" | "allow" | "block"; countries: string[] }): CountryRestriction {
  const countries = [...new Set(input.countries.map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (countries.some((value) => !/^[A-Z]{2}$/u.test(value))) {
    throw new ToolError("Country codes must be two-letter ISO codes, for example IN, US, or GB.");
  }
  if (input.mode !== "off" && countries.length === 0) {
    throw new ToolError("Choose at least one country, or set mode to off.");
  }
  return { mode: input.mode, countries: input.mode === "off" ? [] : countries };
}

function validateFormFields(fields: FormDefinitionInput["fields"]): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (field.label.trim() === "") throw new ToolError(`Form field ${field.name} needs a non-empty label.`);
    if (names.has(field.name)) throw new ToolError(`Duplicate form field name: ${field.name}`);
    names.add(field.name);
    if ((field.type === "select" || field.type === "radio") && (!field.options || field.options.length === 0)) {
      throw new ToolError(`Form field ${field.name} needs options for a ${field.type} field.`);
    }
    if (field.options) {
      const unique = new Set(field.options.map((option) => option.trim()));
      if (unique.size !== field.options.length) throw new ToolError(`Form field ${field.name} has duplicate options.`);
    }
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatNumber(value: number): string {
  return Number(value).toLocaleString("en-US");
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function truncate(value: string, length: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function normalizeForTitle(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function ok(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

async function runTool(
  name: string,
  ctx: ToolContext,
  callback: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof ToolError || error instanceof SiteInputError) {
      return toolError(error.message);
    }
    if (error instanceof PageyApiError) {
      return toolError(error.message);
    }
    ctx.log.error("MCP tool failed", {
      tool: name,
      error: error instanceof Error ? error.name : "unknown",
    });
    return toolError("The Pagey request failed unexpectedly. Try again; if it keeps failing, reconnect the plugin.");
  }
}

function toolError(text: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}
