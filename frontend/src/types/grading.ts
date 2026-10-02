/**
 * 分级账类型：分级组独有的白化等级、样带定级状态与礁区结论。
 * 与外业账（reefs / sites / belts / corals / fishes）物理分表：
 * 外业队的补记永远不覆盖本表，本表只能由分级组在「分级工作台」写入。
 * 两套账通过稳定的样带 id（按样带编号对账时的身份）关联。
 */
import type { BleachLevel, CoralForm } from '@/types/coralRecord'

/** 旧数据升级迁移时的定级人署名 */
export const MIGRATION_GRADER = '系统（旧数据升级补结论）'

/** 分级组对单条珊瑚覆盖记录定的白化等级（id 与外业珊瑚记录 id 相同，便于逐条对账） */
export interface Assessment {
  id: string
  /** 外业珊瑚记录 id（与主键同值，迁移时按 id 对回外业账） */
  beltId: string
  genus: string
  form: CoralForm
  /** 定级时外业覆盖长度（cm）快照——分级组自己留底的那份 */
  coverCm: number
  /** 白化等级：分级组专属，外业改写覆盖不会动它 */
  bleachLevel: BleachLevel
  /** 定级人 */
  gradedBy: string
  /** 定级时间 */
  gradedAt: number
  createdAt: number
  updatedAt: number
}

/** 样带定级状态 */
export type GradeStatus = '未定级' | '已定级' | '待复核' | '有分歧'

export const GRADE_STATUSES: GradeStatus[] = ['未定级', '已定级', '待复核', '有分歧']

/** 状态徽标配色（Element Plus type + 浅底） */
export const GRADE_STATUS_META: Record<GradeStatus, { type: 'info' | 'success' | 'warning' | 'danger'; hint: string }> = {
  未定级: { type: 'info', hint: '分级组尚未定级，白化数字仅供外业自查，不能上报' },
  已定级: { type: 'success', hint: '分级组已按定级时的覆盖快照定级，可作为礁区上报依据' },
  待复核: { type: 'warning', hint: '定级后外业又改了样带或覆盖，等级挂起，等分级组人工复核' },
  有分歧: { type: 'danger', hint: '对账时两边对不上且已挂起，必须人工裁定' }
}

/** 分级账：样带级定级单 */
export interface BeltGrade {
  /** 主键：外业样带稳定 id */
  beltId: string
  /** 对账用样带编号快照（编号变更时同步刷新，但仍以 beltId 为准） */
  beltNo: string
  siteId: string
  status: GradeStatus
  /** 最近一次定级 / 复核确认时的覆盖依据哈希（样带属性 + 珊瑚覆盖，不含白化等级） */
  basisHash: string
  /** 总体白化等级（null = 尚未定级） */
  grade: BleachLevel | null
  /** 定级时白化指数快照（0 ~ 4） */
  bleachIndex: number | null
  gradedBy: string
  gradedAt: number | null
  /** 待复核 / 分歧原因或人工备注 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 分级账：礁区结论（分级组撰写，外业不可改） */
export interface ReefConclusion {
  reefId: string
  reefName: string
  conclusion: string
  gradedBy: string
  gradedAt: number
  createdAt: number
  updatedAt: number
}

/* ------------------------------ 断网同步发件箱 ------------------------------ */

export type OutboxEntity = 'reef' | 'site' | 'belt' | 'coral'

export interface OutboxItem {
  /** 主键：`${entity}:${entityId}`，同一实体的反复修改合并为一条 */
  id: string
  entity: OutboxEntity
  entityId: string
  /** coral 变更冗余所属样带 id，网络恢复后直接按样带对账 */
  beltId?: string
  op: 'upsert' | 'delete'
  createdAt: number
  updatedAt: number
  /** 已尝试同步次数 */
  attempts: number
  /** 最近一次同步中断原因（null = 尚未失败） */
  lastError: string | null
}

/* ------------------------------ 对账异常挂账 ------------------------------ */

export type IssueKind = 'coverage-changed' | 'belt-deleted' | 'duplicate-no' | 'reef-deleted'

export interface SyncIssue {
  /** 主键：`${kind}:${entityId}`，同类异常不重复挂账 */
  id: string
  kind: IssueKind
  beltId?: string
  reefId?: string
  title: string
  detail: string
  createdAt: number
  resolvedAt: number | null
  /** 人工裁定方式说明 */
  resolution: string | null
}

/** 人工裁定动 */
export type IssueResolution =
  | 'regrade' // 覆盖变更：按新覆盖重新定级
  | 'keep-old' // 覆盖变更：维持原等级，仅刷新对账基线
  | 'drop-grading' // 外业已删除：连带删除分级账
  | 'keep-grading' // 外业已删除：分级账留底备查
  | 'recheck' // 编号重复：外业已改编号，重新对账

export const ISSUE_KIND_META: Record<IssueKind, { label: string; type: 'warning' | 'danger' | 'info' }> = {
  'coverage-changed': { label: '覆盖已变更', type: 'warning' },
  'belt-deleted': { label: '外业样带已删', type: 'danger' },
  'duplicate-no': { label: '样带编号重复', type: 'warning' },
  'reef-deleted': { label: '外业礁区已删', type: 'danger' }
}
