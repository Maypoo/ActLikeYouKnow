import { validateAllScripts, scriptsByCount } from "./registry.js"
import type { PlayerCount } from "./types.js"

const result = validateAllScripts()
console.log("counts:", result.counts)
if (result.duplicateIds.length > 0) {
  console.error("duplicate ids:", result.duplicateIds)
  process.exit(1)
}
for (const count of [2, 3, 4, 5] as PlayerCount[]) {
  const list = scriptsByCount[count]
  console.log(`${String(count).padStart(2, "0")}: ${list.length}/100 ${list.length < 100 ? "(faltan " + (100 - list.length) + ")" : "ok"}`)
}
console.log("06-10.json deprecated: split >5 usa 02-05 (ej: 6→3+3, 7→3+4|2+5)")
if (!result.ok) process.exit(1)
console.log("all scripts valid")
