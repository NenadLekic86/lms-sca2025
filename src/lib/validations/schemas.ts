import { z } from 'zod';
import { ROLES } from "@/types";

// ============================================
// SHARED ENUMS
// ============================================
export const roleEnum = z.enum(ROLES);

// ============================================
// USER SCHEMAS
// ============================================
export const fullNameSchema = z
  .string()
  .trim()
  .min(2, "Full name must be at least 2 characters")
  .max(120, "Full name must be at most 120 characters")
  .optional()
  .or(z.literal(''))
  .transform(val => val?.trim() || null);

export const inviteUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  full_name: fullNameSchema,
  role: roleEnum,
  organization_id: z.string().uuid('Invalid organization ID').nullable().optional(),
}).superRefine((val, ctx) => {
  if ((val.role === 'member' || val.role === 'organization_admin') && !val.organization_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['organization_id'],
      message: 'Organization is required for this role',
    });
  }
});

export const changeRoleSchema = z.object({
  role: roleEnum.refine(role => role !== 'super_admin', {
    message: 'Cannot assign super_admin role',
  }),
});

export const assignOrganizationSchema = z.object({
  organization_id: z.string().uuid('Invalid organization ID'),
});

// ============================================
// ORGANIZATION SCHEMAS
// ============================================
export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, "Organization name must be at least 2 characters").max(100),
  slug: z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes").optional(),
});

// ============================================
// SETTINGS SCHEMAS
// ============================================
export const themeSchema = z.record(z.string(), z.string()).nullable();

export const updateSettingsSchema = z.object({
  app_name: z.string().trim().max(100).optional(),
  logo_url: z.string().url().or(z.literal('')).optional(),
  default_language: z.string().min(2).max(10).optional(),
  timezone: z.string().min(1).max(50).optional(),
  theme: themeSchema.optional(),
}).refine(data => {
  // At least one branding field must be present
  if ('app_name' in data && 'logo_url' in data) {
    const hasAppName = data.app_name && data.app_name.trim().length > 0;
    const hasLogo = data.logo_url && data.logo_url.trim().length > 0;
    return hasAppName || hasLogo;
  }
  return true;
}, {
  message: 'At least app_name or logo_url must be provided',
});

// ============================================
// PROFILE SCHEMAS
// ============================================
export const updateProfileSchema = z.object({
  full_name: fullNameSchema,
});

// ============================================
// COURSES SCHEMAS
// ============================================

export const courseVisibilityEnum = z.enum(['all', 'organizations']);
export type CourseVisibilityScope = z.infer<typeof courseVisibilityEnum>;

export const courseTitleSchema = z
  .string()
  .trim()
  .min(2, "Title must be at least 2 characters")
  .max(160, "Title must be at most 160 characters");

export const courseExcerptSchema = z
  .string()
  .trim()
  .max(280, "Excerpt must be at most 280 characters")
  .optional()
  .or(z.literal(''))
  .transform(val => val?.trim() || null);

export const courseDescriptionSchema = z
  .string()
  .trim()
  .max(5000, "Description must be at most 5000 characters")
  .optional()
  .or(z.literal(''))
  .transform(val => val?.trim() || null);

export const createCourseSchema = z.object({
  title: courseTitleSchema,
  excerpt: courseExcerptSchema,
  description: courseDescriptionSchema,
  visibility_scope: courseVisibilityEnum.default('organizations'),
  organization_ids: z.array(z.string().uuid('Invalid organization ID')).optional(),
});

export const updateCourseSchema = z.object({
  title: courseTitleSchema.optional(),
  excerpt: courseExcerptSchema.optional(),
  description: courseDescriptionSchema.optional(),
  is_published: z.boolean().optional(),
  visibility_scope: courseVisibilityEnum.optional(),
  organization_ids: z.array(z.string().uuid('Invalid organization ID')).optional(),
});

// ============================================
// API RESPONSE HELPER
// ============================================
export type ZodValidationResult<T> = 
  | { success: true; data: T }
  | { success: false; error: string };

export function validateSchema<T>(schema: z.ZodSchema<T>, data: unknown): ZodValidationResult<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  // zod v4 uses .issues instead of .errors
  const firstIssue = result.error.issues[0];
  return { 
    success: false, 
    error: firstIssue?.message || 'Validation failed' 
  };
}