import { z } from "zod"
import { PlayerCountSchema, AnyPlayerCountSchema, ScriptsFileSchema, type PlayerCount, type AnyPlayerCount, type Script, type PlayerScriptView, type ScriptRevealView, type CharacterAssignment } from "./types.js"
import data02 from "./data/02.json" with { type: "json" }
import data03 from "./data/03.json" with { type: "json" }
import data04 from "./data/04.json" with { type: "json" }
import data05 from "./data/05.json" with { type: "json" }

const rawByCount: Record<PlayerCount, unknown> = {
  2: data02,
  3: data03,
  4: data04,
  5: data05,
}

function parseFile(count: PlayerCount): Script[] {
  const raw = rawByCount[count]
  return ScriptsFileSchema.parse(raw)
}

export const scriptsByCount: Record<PlayerCount, Script[]> = {
  2: parseFile(2),
  3: parseFile(3),
  4: parseFile(4),
  5: parseFile(5),
}

export function validateAllScripts(): { ok: boolean; counts: Record<PlayerCount, number>; duplicateIds: string[] } {
  const counts = {} as Record<PlayerCount, number>
  const seen = new Map<string, number>()
  const duplicates: string[] = []
  for (const count of [2, 3, 4, 5] as PlayerCount[]) {
    const list = scriptsByCount[count]
    counts[count] = list.length
    for (const s of list) {
      const c = seen.get(s.id) ?? 0
      seen.set(s.id, c + 1)
      if (c + 1 === 2) duplicates.push(s.id)
    }
  }
  return { ok: duplicates.length === 0, counts, duplicateIds: duplicates }
}

export function getScriptsForCount(count: number): Script[] {
  const parsed = PlayerCountSchema.safeParse(count)
  if (!parsed.success) return []
  return scriptsByCount[parsed.data] ?? []
}

export function getRandomScript(count: number, excludeIds: string[] = []): Script | null {
  const pool = getScriptsForCount(count).filter((s) => !excludeIds.includes(s.id))
  if (pool.length === 0) return null
  const idx = Math.floor(Math.random() * pool.length)
  return pool[idx] ?? null
}

export function getScriptById(id: string): Script | null {
  for (const count of [2, 3, 4, 5] as PlayerCount[]) {
    const found = scriptsByCount[count].find((s) => s.id === id)
    if (found) return found
  }
  return null
}

function shuffleInPlace<T>(arr: T[]): T[] {
  const next = [...arr]
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = next[i]!
    next[i] = next[j]!
    next[j] = tmp
  }
  return next
}

export function assignCharactersToPlayers(script: Script, playerIds: string[]): Map<string, CharacterAssignment> {
  const parsed = z.array(z.string().min(1)).min(script.playerCount).max(script.playerCount).safeParse(playerIds)
  if (!parsed.success) throw new Error("playerIds length must equal script playerCount")
  if (playerIds.length !== script.playerCount) throw new Error("playerIds length must equal script playerCount")
  const shuffledChars = shuffleInPlace(script.characters)
  const result = new Map<string, CharacterAssignment>()
  for (let i = 0; i < playerIds.length; i++) {
    const pid = playerIds[i]!
    const character = shuffledChars[i]!
    const lines = script.lines.filter((l) => l.characterId === character.id)
    result.set(pid, { character, lines })
  }
  return result
}

export function buildPlayerViews(script: Script, assignments: Map<string, CharacterAssignment>): Map<string, PlayerScriptView> {
  const views = new Map<string, PlayerScriptView>()
  for (const [pid, assignment] of assignments) {
    views.set(pid, {
      scriptId: script.id,
      scriptTitle: script.title,
      character: assignment.character,
      lines: assignment.lines,
      totalLines: script.lines.length,
    })
  }
  return views
}

export function buildRevealView(script: Script): ScriptRevealView {
  return {
    scriptId: script.id,
    scriptTitle: script.title,
    characters: script.characters,
    lines: [...script.lines].sort((a, b) => a.order - b.order),
  }
}

const SPLIT_PARTITIONS: Record<number, number[][]> = {
  6: [[3, 3]],
  7: [[3, 4]],
  8: [[4, 4]],
  9: [[4, 5]],
  10: [[5, 5]],
}

export type SplitAssignment = {
  act: 1 | 2
  script: Script
  playerIds: string[]
  assignments: Map<string, CharacterAssignment>
  views: Map<string, PlayerScriptView>
}

export type SplitResult = {
  totalPlayers: number
  partition: [number, number]
  acts: [SplitAssignment, SplitAssignment]
}

export function getRandomPartition(totalPlayers: number): [number, number] | null {
  const parsed = AnyPlayerCountSchema.safeParse(totalPlayers)
  if (!parsed.success) return null
  if (totalPlayers <= 5) return null
  const options = SPLIT_PARTITIONS[totalPlayers]
  if (!options || options.length === 0) return null
  const idx = Math.floor(Math.random() * options.length)
  const chosen = options[idx]!
  const shuffled = Math.random() < 0.5 ? [chosen[0]!, chosen[1]!] : [chosen[1]!, chosen[0]!]
  return shuffled as [number, number]
}

export function getScriptsForSplit(totalPlayers: number, excludeIds: string[] = []): [Script, Script] | null {
  const partition = getRandomPartition(totalPlayers)
  if (!partition) return null
  const [a, b] = partition
  const s1 = getRandomScript(a, excludeIds)
  if (!s1) return null
  let s2 = getRandomScript(b, [...excludeIds, s1.id])
  if (!s2) s2 = getRandomScript(b, excludeIds)
  if (!s2) return null
  return [s1, s2]
}

export function assignSplitScripts(totalPlayerIds: string[], scripts: [Script, Script], partition: [number, number]): SplitResult {
  if (totalPlayerIds.length !== partition[0] + partition[1]) throw new Error("partition sum must equal player count")
  if (scripts[0].playerCount !== partition[0] || scripts[1].playerCount !== partition[1]) throw new Error("script playerCount must match partition")
  const shuffledIds = shuffleInPlace(totalPlayerIds)
  const g1 = shuffledIds.slice(0, partition[0])
  const g2 = shuffledIds.slice(partition[0])
  const a1 = assignCharactersToPlayers(scripts[0], g1)
  const a2 = assignCharactersToPlayers(scripts[1], g2)
  return {
    totalPlayers: totalPlayerIds.length,
    partition,
    acts: [
      { act: 1, script: scripts[0], playerIds: g1, assignments: a1, views: buildPlayerViews(scripts[0], a1) },
      { act: 2, script: scripts[1], playerIds: g2, assignments: a2, views: buildPlayerViews(scripts[1], a2) },
    ],
  }
}

export function getAndAssignForRoom(playerIds: string[]): { single: { script: Script; assignments: Map<string, CharacterAssignment>; views: Map<string, PlayerScriptView> } | null; split: SplitResult | null } {
  const n = playerIds.length
  if (n >= 2 && n <= 5) {
    const script = getRandomScript(n)
    if (!script) return { single: null, split: null }
    const assignments = assignCharactersToPlayers(script, playerIds)
    return { single: { script, assignments, views: buildPlayerViews(script, assignments) }, split: null }
  }
  if (n >= 6 && n <= 10) {
    const scripts = getScriptsForSplit(n)
    if (!scripts) return { single: null, split: null }
    const partition: [number, number] = [scripts[0].playerCount as number, scripts[1].playerCount as number] as [number, number]
    const split = assignSplitScripts(playerIds, scripts, partition)
    return { single: null, split }
  }
  return { single: null, split: null }
}
