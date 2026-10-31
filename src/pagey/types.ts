export interface PageyUser {
  id: string;
  email: string;
  isEmailVerified: boolean;
  tier: string;
  createdAt: string;
  updatedAt: string;
}

export interface CountryRestriction {
  mode: "off" | "allow" | "block";
  countries: string[];
}

export interface PageySite {
  id: string;
  subdomain: string;
  title: string | null;
  status: "active" | "deleted" | "expired" | string;
  isPasswordProtected: boolean;
  passwordDisabledUntil?: string | null;
  expiresAt: string | null;
  maintenanceMode: boolean;
  countryRestriction?: CountryRestriction;
  contentRevision?: number;
  servingPaused?: boolean;
  analyticsPaused?: boolean;
  editsPaused?: boolean;
  createdAt: string;
  updatedAt: string;
  lastPublishedAt?: string | null;
  tags: string[];
}

export interface SiteList {
  page: number;
  pageSize: number;
  total: number;
  items: PageySite[];
}

export interface CreateSiteInput {
  zip: Uint8Array;
  title?: string;
  password?: string;
  expiresAt?: string;
  subdomain?: string;
}

export interface SiteMetadataPatch {
  title?: string | null;
  expiresAt?: string | null;
  password?: string | null;
  countryRestriction?: CountryRestriction;
}

export interface Analytics {
  from: string;
  to: string;
  pageViews: number;
  uniqueVisitors: number;
  sessions: number;
  daily: Array<{ day: string; pageViews: number }>;
  referrers: Array<{ referrer: string; count: number }>;
  countries: Array<{ countryCode: string; count: number }>;
  topPages: Array<{ path: string; pageViews: number; uniqueVisitors: number }>;
  entryPages: Array<{ path: string; entries: number }>;
  exitPages: Array<{ path: string; exits: number }>;
  devices: Array<{ deviceType: string; count: number }>;
  browsers: Array<{ browser: string; count: number }>;
  operatingSystems: Array<{ os: string; count: number }>;
  trafficSources: Array<{ source: string; count: number }>;
  trafficSourceDetails: Array<{ source: string; detail: string; count: number }>;
  utmSources: Array<{ source: string; count: number }>;
  utmMediums: Array<{ medium: string; count: number }>;
  utmCampaigns: Array<{ campaign: string; count: number }>;
}

export type FormFieldType =
  | "text"
  | "email"
  | "tel"
  | "textarea"
  | "number"
  | "date"
  | "url"
  | "select"
  | "radio"
  | "checkbox";

export interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  placeholder?: string;
  options?: string[];
}

export interface FormDefinitionInput {
  title: string;
  description?: string;
  fields: FormField[];
  settings?: {
    acceptingResponses?: boolean;
    allowResubmit?: boolean;
    submitLabel?: string;
    successMessage?: string;
  };
  styles?: {
    background?: string;
    text?: string;
    accent?: string;
    buttonText?: string;
    font?: "sans" | "serif" | "mono";
    radius?: number;
    width?: number;
  };
}

export interface PageyForm {
  id: string;
  title: string | null;
  status: string;
  definition: unknown;
  createdAt: string;
  updatedAt: string;
  responseCount?: number;
  siteSubdomain?: string | null;
  siteTitle?: string | null;
}

export interface FormList {
  page: number;
  pageSize: number;
  total: number;
  items: PageyForm[];
}

export interface FormResponse {
  id: string;
  formId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  phone: string | null;
  inputText: string | null;
  extraFields: Record<string, unknown>;
  ipAddress: string | null;
  submittedAt: string;
}

export interface FormResponseList {
  form: PageyForm;
  page: number;
  pageSize: number;
  total: number;
  items: FormResponse[];
}
