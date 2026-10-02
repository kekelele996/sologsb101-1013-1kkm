/** 珊瑚形态 */
export type CoralForm = '枝状' | '块状' | '叶状' | '软珊瑚'

export const CORAL_FORMS: CoralForm[] = ['枝状', '块状', '叶状', '软珊瑚']

/** 白化等级 */
export type BleachLevel = '无' | '轻' | '中' | '重' | '死亡'

export const BLEACH_LEVELS: BleachLevel[] = ['无', '轻', '中', '重', '死亡']

/**
 * 珊瑚记录：样带内某属名、某形态的覆盖长度。
 * 注意 v3 起 bleachLevel 不再由外业队维护：白化等级归分级组账（assessments）。
 * 该字段仅为旧数据历史兼容保留（升级时整列移交分级账），外业表单与批量粘贴都不再写入。
 */
export interface CoralRecord {
  id: string
  /** 所属样带 */
  beltId: string
  /** 属名，如 鹿角珊瑚属 */
  genus: string
  /** 形态 */
  form: CoralForm
  /** 覆盖长度（cm） */
  coverCm: number
  /** @deprecated v3 起归分级组账 assessments，外业不可写，仅旧数据兼容 */
  bleachLevel: BleachLevel
  /** 备注（病敌害、断枝等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 珊瑚记录草稿（外业队只录覆盖，不录白化等级；等级在分级工作台定） */
export interface CoralDraft {
  genus: string
  form: CoralForm
  coverCm: number
  remark: string
}

export function createEmptyCoralDraft(): CoralDraft {
  return {
    genus: '',
    form: '枝状',
    coverCm: 100,
    remark: ''
  }
}

/** 常见属名（表单联想用） */
export const COMMON_GENERA: string[] = [
  '鹿角珊瑚属',
  '杯形珊瑚属',
  '滨珊瑚属',
  '蜂巢珊瑚属',
  '蔷薇珊瑚属',
  '陀螺珊瑚属',
  '石芝珊瑚属',
  '软珊瑚属',
  '柳珊瑚属',
  '星珊瑚属'
]

/** 批量粘贴解析出的一行珊瑚覆盖记录（白化等级不归外业，第 4 列即便粘了等级也忽略） */
export interface CoralPasteRow {
  genus: string
  form: CoralForm
  coverCm: number
}

/**
 * 解析批量粘贴文本：每行「属名,形态,覆盖长度」。
 * 逗号 / 制表符 / 分号可作分隔（属名常含空格，不用空格定界）。
 * 兼容旧模板里第 4 列的白化等级：不再报错，解析时忽略并提示（等级去分级工作台定）。
 */
export function parseCoralPaste(text: string): { rows: CoralPasteRow[]; errors: string[]; ignoredLevels: number } {
  const rows: CoralPasteRow[] = []
  const errors: string[] = []
  let ignoredLevels = 0
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 3) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「属名,形态,覆盖长度(cm)」三列`)
      return
    }
    const form = cells[1] as CoralForm
    if (!CORAL_FORMS.includes(form)) {
      errors.push(`第 ${index + 1} 行形态「${cells[1]}」不在 ${CORAL_FORMS.join(' / ')} 之内`)
      return
    }
    const coverCm = Number(cells[2])
    if (!Number.isFinite(coverCm) || coverCm < 0) {
      errors.push(`第 ${index + 1} 行覆盖长度应为非负数字（cm）`)
      return
    }
    // 旧模板第 4 列白化等级：外业账不再记录，忽略即可（若是合法等级则计数提示）
    if (cells.length >= 4 && cells[3] !== '' && BLEACH_LEVELS.includes(cells[3] as BleachLevel)) {
      ignoredLevels += 1
    }
    rows.push({
      genus: cells[0],
      form,
      coverCm: Number(coverCm.toFixed(1))
    })
  })
  return { rows, errors, ignoredLevels }
}
