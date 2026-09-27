import { z } from 'zod';

// null follows global availability; [] explicitly selects nothing.
const selection = (max: number) =>
  z
    .array(z.string().uuid())
    .max(max)
    .transform((ids) => [...new Set(ids)])
    .nullable()
    .default(null);
export const chatToolsInput = z
  .object({
    mcp: selection(20),
    skills: selection(100),
  })
  .strict();
export type ChatTools = z.infer<typeof chatToolsInput>;
