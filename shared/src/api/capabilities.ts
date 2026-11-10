import { z } from 'zod';

/**
 * `GET /api/capabilities` and the owner's skills and subagents (ADR-0025, spec agent-capabilities).
 * Skills and subagents come from three sources; only the owner's own can be written, and only
 * through these routes, never through a tool an agent can call.
 */
export const CAPABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CAPABILITY_DESCRIPTION_MAX = 1024;
/** Bytes of UTF-8 in a skill or subagent body. */
export const CAPABILITY_BODY_MAX_BYTES = 64 * 1024;
/** The models a subagent may name: the aliases `claude --model` takes. */
export const CAPABILITY_MODELS = ['sonnet', 'opus', 'haiku'] as const;

export const CAPABILITY_KINDS = ['skills', 'agents'] as const;
export const CapabilityKindSchema = z.enum(CAPABILITY_KINDS);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

export const CapabilitySourceSchema = z.enum(['builtin', 'owner', 'repo']);
export type CapabilitySource = z.infer<typeof CapabilitySourceSchema>;

export const CapabilityNameSchema = z
  .string()
  .regex(
    CAPABILITY_NAME_PATTERN,
    'must be lowercase letters, digits and dashes, up to 64, not starting with a dash',
  );

/** The frontmatter is line-based, so a description is one line. */
const DescriptionSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(CAPABILITY_DESCRIPTION_MAX)
  .refine((value) => !/[\r\n]/.test(value), 'must be a single line');

const BodySchema = z
  .string()
  .refine(
    (value) => new TextEncoder().encode(value).length <= CAPABILITY_BODY_MAX_BYTES,
    `must be at most ${CAPABILITY_BODY_MAX_BYTES / 1024} KB`,
  );

const ToolSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(200)
  .refine((value) => !/[,\r\n]/.test(value), 'must not contain a comma or a line break');

export const OwnerSkillInputSchema = z.strictObject({
  description: DescriptionSchema,
  body: BodySchema,
});
export type OwnerSkillInput = z.infer<typeof OwnerSkillInputSchema>;

export const OwnerAgentInputSchema = z.strictObject({
  description: DescriptionSchema,
  body: BodySchema,
  tools: z.array(ToolSchema).max(100).optional(),
  model: z.enum(CAPABILITY_MODELS).optional(),
});
export type OwnerAgentInput = z.infer<typeof OwnerAgentInputSchema>;

export const OwnerCapabilityParamsSchema = z.strictObject({ name: CapabilityNameSchema });

/** One skill or subagent in the list. */
export const CapabilityItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: CapabilitySourceSchema,
  /** `owner/name`, for `source: 'repo'`. */
  repo: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  /** True only for the owner's own items. */
  editable: z.boolean(),
});
export type CapabilityItem = z.infer<typeof CapabilityItemSchema>;

export const MCP_ROLES = ['dispatcher', 'worker', 'ui_check'] as const;

/** An MCP server a run can reach. Never carries a value from `.env` or `servers.json`'s `env`. */
export const McpServerItemSchema = z.object({
  name: z.string(),
  source: z.enum(['builtin', 'connector']),
  roles: z.array(z.enum(MCP_ROLES)),
  transport: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  /** Names only: the variables the server is given or reads, never their values. */
  envVars: z.array(z.string()),
});
export type McpServerItem = z.infer<typeof McpServerItemSchema>;

export const CapabilitiesSchema = z.object({
  skills: z.array(CapabilityItemSchema),
  agents: z.array(CapabilityItemSchema),
  mcpServers: z.array(McpServerItemSchema),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** `GET /api/capabilities/owner/{skills|agents}/:name`: the parts the editor needs, and the file. */
export const OwnerCapabilityDocSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  /** The whole file as written, frontmatter included. */
  markdown: z.string(),
});
export type OwnerCapabilityDoc = z.infer<typeof OwnerCapabilityDocSchema>;
