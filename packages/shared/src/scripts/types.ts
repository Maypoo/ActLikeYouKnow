import { z } from "zod"

export const PlayerCountSchema = z.number().int().min(2).max(5)
export type PlayerCount = z.infer<typeof PlayerCountSchema>

export const AnyPlayerCountSchema = z.number().int().min(2).max(10)
export type AnyPlayerCount = z.infer<typeof AnyPlayerCountSchema>

export const ScriptCharacterSchema = z.object({
  id: z.string().min(1).max(16).regex(/^[a-z0-9]+$/),
})

export type ScriptCharacter = z.infer<typeof ScriptCharacterSchema>

export const ScriptLineSchema = z.object({
  characterId: z.string().min(1).max(16),
  text: z.string().trim().min(1).max(280),
  order: z.number().int().min(0),
})

export type ScriptLine = z.infer<typeof ScriptLineSchema>

export const ScriptSchema = z
  .object({
    id: z.string().min(3).max(48).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    title: z.string().trim().min(3).max(60),
    synopsis: z.string().trim().min(1).max(200).optional(),
    playerCount: PlayerCountSchema,
    characters: z.array(ScriptCharacterSchema).min(2).max(5),
    lines: z.array(ScriptLineSchema).min(1).max(40),
    tags: z.array(z.string().trim().min(1).max(20)).max(6).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.characters.length !== value.playerCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `characters.length must equal playerCount`,
        path: ["characters"],
      })
    }
    const charIds = new Set(value.characters.map((c) => c.id))
    if (charIds.size !== value.characters.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `character ids must be unique`,
        path: ["characters"],
      })
    }
    for (let i = 0; i < value.lines.length; i++) {
      const line = value.lines[i]!
      if (!charIds.has(line.characterId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `line[${i}].characterId must match a character id`,
          path: ["lines", i, "characterId"],
        })
      }
      if (line.order !== i) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `line[${i}].order must equal index ${i}`,
          path: ["lines", i, "order"],
        })
      }
    }
    const idSet = new Set<string>()
    if (idSet.has(value.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate script id`,
        path: ["id"],
      })
    }
  })

export type Script = z.infer<typeof ScriptSchema>

export const ScriptsFileSchema = z.array(ScriptSchema)

export function defineScript(script: Script): Script {
  return ScriptSchema.parse(script)
}

export type CharacterAssignment = {
  character: ScriptCharacter
  lines: ScriptLine[]
}

export type PlayerScriptView = {
  scriptId: string
  scriptTitle: string
  character: ScriptCharacter
  lines: ScriptLine[]
  totalLines: number
}

export type ScriptRevealView = {
  scriptId: string
  scriptTitle: string
  characters: ScriptCharacter[]
  lines: ScriptLine[]
}
