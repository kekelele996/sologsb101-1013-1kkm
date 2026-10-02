/**
 * 同步与对账类型：外业份与分级份各自持有自己那份记录，
 * 外业写入先进离线待同步队列（outbox），网络恢复后按样带编号与分级组对账。
 * - 外业份（belts / corals）：外业队管样带与珊瑚覆盖
 * - 分级份（bleachGrades / reefConclusions）：分级组管白化等级与礁区结论
 */
import type { BleachLevel } from '@/types/coralRecord'

/** 待同步队列状态：待同步 / 已同步 / 同步失败（中断后留外业重试） */
export type OutboxStatus = 'pending' | 'synced' | 'failed'

/** 纳入外业待同步队列的实体类型 */
export type OutboxEntityType = 'belt' | 'coral' | 'fish'

/** 外业写入动作 */
export type OutboxAction = 'create' | 'update' | 'delete'

/**
 * 外业待同步队列条目：外业队在现场断网时照旧记账，写入先落本地队列，
 * 网络恢复后按样带编号（beltNo + siteNo）与分级组对账。
 */
export interface OutboxEntry {
  id: string
  /** 实体类型：样带 / 珊瑚记录 / 鱼类计数 */
  entityType: OutboxEntityType
  /** 实体 id（样带 / 珊瑚 / 鱼类记录的 id） */
  entityId: string
  /** 所属样带 id（珊瑚/鱼类记录归属的样带；样带记录即自身） */
  beltId: string
  /** 样带编号（对账业务键，如 T-01） */
  beltNo: string
  /** 站位编号（对账业务键，如 S-01） */
  siteNo: string
  /** 所属礁区 id */
  reefId: string
  /** 写入动作 */
  action: OutboxAction
  /** 外业份写入后的新状态快照（JSON 字符串） */
  payload: string
  /** 写入前的旧状态快照（JSON 字符串），用于回退；create 时为空 */
  prevPayload: string
  status: OutboxStatus
  /** 重试次数 */
  attempts: number
  /** 最近一次失败原因 */
  lastError: string
  createdAt: number
  syncedAt: number | null
}

/** 对账问题类型：已定级样带被外业改动（待复核）/ 外业覆盖与分级定级对不上（对账不符） */
export type IssueType = 'graded_belt_modified' | 'grade_conflict'

/** 对账问题状态：待处理 / 已人工定论 */
export type IssueStatus = 'open' | 'resolved'

/** 人工定论方式 */
export type IssueResolution =
  | 'field_wins' // 以外业份为准（分级定级作废，重评）
  | 'grading_wins' // 以分级份为准（回退外业覆盖改动）
  | 'resubmit_grading' // 提交分级组重评（作废定级）
  | 'revert_field' // 按分级记录回退外业改动
  | 'manual_keep' // 人工已核对，维持现状

/**
 * 对账问题：外业改动与分级份记录对不上时，留待人工定论，分级份那份照旧不被覆盖。
 */
export interface ReconcileIssue {
  id: string
  type: IssueType
  status: IssueStatus
  beltId: string
  beltNo: string
  siteNo: string
  reefId: string
  title: string
  summary: string
  /** 外业份快照（JSON 字符串） */
  fieldPayload: string
  /** 分级份快照（JSON 字符串） */
  gradingPayload: string
  resolution: IssueResolution | null
  resolvedBy: string
  createdAt: number
  resolvedAt: number | null
}

/**
 * 分级组定级记录（分级份）：一条样带一条权威白化等级。
 * 外业份的珊瑚覆盖改动不会覆盖它，只会触发待复核 / 对账不符。
 */
export interface BleachGrade {
  id: string
  beltId: string
  beltNo: string
  reefId: string
  /** 分级组评定的权威白化等级 */
  bleachLevel: BleachLevel
  /** 分级结论 / 定级备注 */
  conclusion: string
  /** 定级时外业珊瑚覆盖快照（JSON 字符串），用于对账与回退 */
  coverSnapshot: string
  /** 定级时样带头快照（JSON 字符串），用于回退 */
  beltSnapshot: string
  gradedBy: string
  gradedAt: number
  updatedAt: number
}

/**
 * 礁区结论（分级份）：分级组出具的礁区白化结论。
 */
export interface ReefConclusion {
  id: string
  reefId: string
  /** 礁区结论 */
  conclusion: string
  updatedBy: string
  updatedAt: number
}

/** 外业份珊瑚覆盖摘要（用于对账展示与快照比对） */
export interface CoverSnapshotItem {
  genus: string
  form: string
  coverCm: number
  bleachLevel: BleachLevel
  remark: string
}

/** 从快照 JSON 解析覆盖摘要 */
export function parseCoverSnapshot(raw: string): CoverSnapshotItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        genus: typeof item.genus === 'string' ? item.genus : '',
        form: typeof item.form === 'string' ? item.form : '',
        coverCm: typeof item.coverCm === 'number' ? item.coverCm : 0,
        bleachLevel: item.bleachLevel === '无' || item.bleachLevel === '轻' || item.bleachLevel === '中' || item.bleachLevel === '重' || item.bleachLevel === '死亡' ? item.bleachLevel : '无',
        remark: typeof item.remark === 'string' ? item.remark : ''
      }))
  } catch {
    return []
  }
}

/** 对账问题类型文案 */
export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  graded_belt_modified: '待复核',
  grade_conflict: '对账不符'
}

/** 对账问题类型配色（Element Plus tag type） */
export const ISSUE_TYPE_TAG: Record<IssueType, 'warning' | 'danger'> = {
  graded_belt_modified: 'warning',
  grade_conflict: 'danger'
}

/** 定论方式文案 */
export const ISSUE_RESOLUTION_LABEL: Record<IssueResolution, string> = {
  field_wins: '以外业覆盖为准',
  grading_wins: '以分级定级为准',
  resubmit_grading: '提交分级组重评',
  revert_field: '按分级记录回退',
  manual_keep: '人工已核对，维持现状'
}
