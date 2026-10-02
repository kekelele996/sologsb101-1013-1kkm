/**
 * 对账基线：外业样带覆盖依据快照与哈希。
 * 只纳入「外业队管」的字段（样带属性 + 珊瑚属名/形态/覆盖长度），
 * 不纳入白化等级——等级是分级组那份账的内容，外业怎么补记都不该影响对账基线以外的判定。
 */
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'

/** 单条珊瑚覆盖依据（剔除白化等级） */
export interface CoralBasis {
  id: string
  genus: string
  form: CoralRecord['form']
  coverCm: number
}

/** 一条样带的对账依据 */
export interface BeltBasis {
  belt: Pick<Belt, 'id' | 'siteId' | 'no' | 'lengthM' | 'orientation' | 'surveyDate' | 'observer'>
  corals: CoralBasis[]
}

/** FNV-1a 32 位哈希：纯前端无 crypto 依赖，稳定可复现（只做对账指纹，不做加密） */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 组装并计算样带覆盖依据哈希（珊瑚按 id 排序，保证与录入顺序无关） */
export function beltBasisHash(belt: Belt, corals: CoralRecord[]): string {
  const basis: BeltBasis = {
    belt: {
      id: belt.id,
      siteId: belt.siteId,
      no: belt.no,
      lengthM: belt.lengthM,
      orientation: belt.orientation,
      surveyDate: belt.surveyDate,
      observer: belt.observer
    },
    corals: corals
      .map((coral) => ({ id: coral.id, genus: coral.genus, form: coral.form, coverCm: coral.coverCm }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  return fnv1a(JSON.stringify(basis))
}
