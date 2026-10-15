import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Parses URL query booleans without treating the string `false` as truthy. */
export const queryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

export type Pagination = z.infer<typeof paginationSchema>;

export const skipTake = ({ page, pageSize }: Pagination) => ({
  skip: (page - 1) * pageSize,
  take: pageSize,
});

export type Paged<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};

export const paged = <T>(data: T[], total: number, pagination: Pagination): Paged<T> => ({
  data,
  meta: {
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)),
  },
});

/** Accepts `?status=a&status=b` and `?status=a,b` alike. */
export const csvArray = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value): string[] | undefined => {
    if (value === undefined) return undefined;
    const parts = (Array.isArray(value) ? value : value.split(','))
      .map((v) => v.trim())
      .filter(Boolean);
    return parts.length ? parts : undefined;
  });

/** Like `csvArray`, but validates each entry against an enum. */
export const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  csvArray.transform((parts, ctx) => {
    if (!parts) return undefined;
    const allowed = new Set<string>(values);
    for (const part of parts) {
      if (!allowed.has(part)) {
        ctx.addIssue({ code: 'custom', message: `Unsupported value: ${part}` });
        return undefined;
      }
    }
    return parts as unknown as T[number][];
  });

export const optionalDate = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null) return null;
    if (v === undefined || v === '') return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid date');
    return d;
  });

export const idSchema = z.string().min(1);

export const cuidParam = (name: string) => z.object({ [name]: z.string().min(1) });
