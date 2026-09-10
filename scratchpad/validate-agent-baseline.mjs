import fs from 'node:fs'

const path = new URL('../benchmarks/agent-pipeline/cases.json', import.meta.url)
const fixture = JSON.parse(fs.readFileSync(path, 'utf8'))
const requiredKinds = new Set(['plain', 'selected-skill', 'auto-discovery', 'no-workspace', 'broken-resource', 'negative-route', 'attachment-media'])
const missingKinds = [...requiredKinds].filter((kind) => !fixture.cases.some((item) => item.kind === kind))
const missingSkills = fixture.skills.filter((skill) => !fixture.cases.some((item) => item.expectedSkill === skill))
const negativeCases = fixture.cases.filter((item) => item.kind === 'negative-route')
if (missingKinds.length || missingSkills.length || negativeCases.length === 0) {
  throw new Error(JSON.stringify({ missingKinds, missingSkills, negativeCases: negativeCases.length }))
}
console.log(JSON.stringify({ version: fixture.version, cases: fixture.cases.length, skills: fixture.skills.length, negativeCases: negativeCases.length }, null, 2))
