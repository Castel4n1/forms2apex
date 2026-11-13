import { z } from "zod";

/** Representação intermediária (IR) produzida pelo parser Python. */
export const ItemSchema = z.object({
  name: z.string(),
  type: z.string().default("Text Item"),
  dataType: z.string().optional(),
  maxLength: z.number().optional(),
  prompt: z.string().optional(),
  label: z.string().optional(),
  required: z.boolean().default(false),
  dbItem: z.boolean().default(true),
  column: z.string().optional(),
  lov: z.string().optional(),
  canvas: z.string().optional(),
  visible: z.boolean().default(true),
  primaryKey: z.boolean().default(false),
  initialValue: z.string().optional(),
  checkedValue: z.string().optional(),
  uncheckedValue: z.string().optional(),
  listValues: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
});

export const BlockSchema = z.object({
  name: z.string(),
  source: z.string().nullish(),
  dbBlock: z.boolean(),
  records: z.number(),
  where: z.string().nullish(),
  orderBy: z.string().nullish(),
  insertAllowed: z.boolean(),
  updateAllowed: z.boolean(),
  deleteAllowed: z.boolean(),
  items: z.array(ItemSchema),
});

export const TriggerSchema = z.object({
  name: z.string(),
  scope: z.enum(["form", "block", "item"]),
  owner: z.string(),
  code: z.string(),
});

export const IRSchema = z.object({
  irVersion: z.literal("1.0"),
  form: z.object({ name: z.string(), title: z.string().nullish(), firstBlock: z.string().nullish() }),
  blocks: z.array(BlockSchema),
  triggers: z.array(TriggerSchema),
  programUnits: z.array(z.object({ name: z.string(), kind: z.string(), code: z.string() })),
  lovs: z.array(z.object({ name: z.string(), recordGroup: z.string().nullish(), title: z.string().nullish() })),
  recordGroups: z.array(z.object({ name: z.string(), query: z.string() })),
  canvases: z.array(z.object({ name: z.string(), kind: z.string() })),
  attachedLibraries: z.array(z.string()),
  meta: z.object({ secretsMasked: z.number() }),
});

export type IR = z.infer<typeof IRSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
