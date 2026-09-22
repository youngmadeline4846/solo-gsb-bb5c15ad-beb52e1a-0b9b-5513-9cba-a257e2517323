import { db } from './db.js';
import { computeStoryOrder } from './schedule.js';

/* ================================ 数据类型 ================================ */

/** 镜头状态：待拍（无任何拍摄条）/ 已拍（有可用最佳条）/ 需重拍（有条但无可用最佳条） */
export type ShotStatus = 'pending' | 'done' | 'reshoot';

/** 需重拍的具体原因（status = 'reshoot' 时有值） */
export type ReshootReason = 'no-best' | 'best-ng' | 'all-ng';

export interface TakeDto {
  id: number;
  shotId: number;
  takeNo: number;
  usable: boolean;
  isBest: boolean;
  note: string;
}

/** 前置镜头的就绪情况（satisfied = 该前置已有可用最佳条） */
export interface ShotPrereqDto {
  shotId: number;
  shotNo: string;
  required: boolean;
  status: ShotStatus;
  reshootReason: ReshootReason | null;
  satisfied: boolean;
}

export interface ShotDto {
  id: number;
  sceneId: number;
  shotNo: string;
  framing: string; // 景别
  camera: string; // 机位
  required: boolean; // 是否必拍
  note: string;
  status: ShotStatus;
  reshootReason: ReshootReason | null;
  bestTakeId: number | null; // 可用最佳条（status = 'done' 时有值）
  prereqIds: number[]; // 前置镜头 id（按前置镜头在场景内的排列顺序）
  prereqs: ShotPrereqDto[]; // 全部前置镜头的逐项就绪情况
  /** 可拍 = 全部前置镜头均已有可用最佳条（无前置镜头时恒为 true） */
  shootable: boolean;
  blockedBy: ShotPrereqDto[]; // 未就绪的前置镜头（逐项阻塞原因）
  takes: TakeDto[];
}

export interface SceneShotsDto {
  sceneId: number;
  title: string;
  storyTime: string;
  seq: number;
  storyIndex: number;
  totalShots: number;
  requiredShots: number;
  doneShots: number; // 有可用最佳条的镜头数
  requiredDone: number; // 必拍镜头中已有可用最佳条的数量
  pendingShots: number;
  reshootShots: number;
  /** 完成度 0..1：有镜头时按「有可用最佳条的镜头 / 总镜头」计；无镜头为 0 */
  completion: number;
  /** 场景完成 = 已建镜头 且 所有必拍镜头均有可用最佳条 */
  complete: boolean;
  /** 下一批可拍队列：可拍且未完成的镜头 id，按「必拍优先、镜头编号自然序」排列 */
  queue: number[];
  shots: ShotDto[];
}

export interface ShotListReport {
  generatedAt: string;
  scenes: SceneShotsDto[];
  totals: {
    scenes: number;
    completeScenes: number;
    scenesWithoutShots: number; // 缺镜头（一个镜头都没建）的场景数
    shots: number;
    requiredShots: number;
    doneShots: number;
    requiredDone: number;
    pendingShots: number;
    reshootShots: number;
    shootableShots: number; // 当前可拍（且未完成）的镜头数，即各场景队列长度之和
  };
}

/* ================================ 工具 ================================ */

/**
 * 镜头编号自然序：按数字/非数字片段比较（'1' < '2' < '2A' < '10'），
 * 完全相等时返回 0，调用方需再以 id 兜底保证确定性。
 */
export function naturalShotNoCompare(a: string, b: string): number {
  const chunk = (s: string): string[] => s.match(/\d+|\D+/g) ?? [];
  const ca = chunk(a);
  const cb = chunk(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const x = ca[i];
    const y = cb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (Number.isNaN(nx) || Number.isNaN(ny)) {
      const c = x.localeCompare(y);
      if (c !== 0) return c;
    } else if (nx !== ny) {
      return nx - ny;
    } else if (x.length !== y.length) {
      // 数值相等时前导零少的排前（'2' < '02'），保证确定性
      return x.length - y.length;
    }
  }
  return 0;
}

/* ================================ 计算 ================================ */

interface ShotRow {
  id: number;
  scene_id: number;
  shot_no: string;
  framing: string;
  camera: string;
  required: number;
  note: string;
  sort_order: number;
}

interface TakeRow {
  id: number;
  shot_id: number;
  take_no: number;
  usable: number;
  is_best: number;
  note: string;
}

interface DepRow {
  shot_id: number;
  dep_shot_id: number;
}

/**
 * 镜头清单（纯读取现算）：
 * - 镜头状态由拍摄条推导：无条 = 待拍；有可用最佳条 = 已拍；其余 = 需重拍；
 * - 前置镜头：仅当全部前置镜头均有可用最佳条时镜头进入「可拍」，否则给出逐项阻塞原因；
 * - 每个场景按「必拍优先、镜头编号自然序」生成下一批可拍队列（可拍且未完成的镜头）；
 * - 场景完成度按镜头状态与最佳条选择计算；只有所有必拍镜头均有可用最佳条时场景才算完成；
 * - 不读取也不修改 snapshots/changes/schedule_*，连续性重放与排程逻辑不受影响。
 */
export function computeShotList(sceneIdFilter = 0): ShotListReport {
  const sceneRows = db
    .prepare('SELECT id, title, story_time, seq FROM scenes ORDER BY story_time ASC, seq ASC, id ASC')
    .all() as { id: number; title: string; story_time: string; seq: number }[];
  const storyIndex = computeStoryOrder(sceneRows);

  const shotRows = db
    .prepare('SELECT * FROM shots ORDER BY scene_id, sort_order, id')
    .all() as unknown as ShotRow[];
  const takeRows = db
    .prepare('SELECT * FROM takes ORDER BY shot_id, take_no, id')
    .all() as unknown as TakeRow[];
  const depRows = db
    .prepare('SELECT shot_id, dep_shot_id FROM shot_deps')
    .all() as unknown as DepRow[];

  const takesByShot = new Map<number, TakeDto[]>();
  for (const t of takeRows) {
    const list = takesByShot.get(t.shot_id) ?? [];
    list.push({
      id: t.id,
      shotId: t.shot_id,
      takeNo: t.take_no,
      usable: t.usable === 1,
      isBest: t.is_best === 1,
      note: t.note,
    });
    takesByShot.set(t.shot_id, list);
  }

  // 前置镜头 id 按「前置镜头在场景内的排列顺序」排序，保证展示与队列确定性
  const shotRowById = new Map(shotRows.map((s) => [s.id, s]));
  const prereqIdsByShot = new Map<number, number[]>();
  for (const d of depRows) {
    const list = prereqIdsByShot.get(d.shot_id) ?? [];
    list.push(d.dep_shot_id);
    prereqIdsByShot.set(d.shot_id, list);
  }
  for (const ids of prereqIdsByShot.values()) {
    ids.sort((a, b) => {
      const ra = shotRowById.get(a);
      const rb = shotRowById.get(b);
      if (!ra || !rb) return a - b;
      return ra.sort_order - rb.sort_order || ra.id - rb.id;
    });
  }

  const shotsByScene = new Map<number, ShotDto[]>();
  const shotById = new Map<number, ShotDto>();
  for (const s of shotRows) {
    const takes = takesByShot.get(s.id) ?? [];
    const best = takes.find((t) => t.isBest);
    const usableBest = best && best.usable ? best : null;
    let status: ShotStatus;
    let reshootReason: ReshootReason | null = null;
    if (takes.length === 0) {
      status = 'pending';
    } else if (usableBest) {
      status = 'done';
    } else {
      status = 'reshoot';
      if (!best) reshootReason = takes.some((t) => t.usable) ? 'no-best' : 'all-ng';
      else reshootReason = 'best-ng';
    }
    const dto: ShotDto = {
      id: s.id,
      sceneId: s.scene_id,
      shotNo: s.shot_no,
      framing: s.framing,
      camera: s.camera,
      required: s.required === 1,
      note: s.note,
      status,
      reshootReason,
      bestTakeId: usableBest ? usableBest.id : null,
      prereqIds: prereqIdsByShot.get(s.id) ?? [],
      prereqs: [],
      shootable: true,
      blockedBy: [],
      takes,
    };
    shotById.set(s.id, dto);
    const list = shotsByScene.get(s.scene_id) ?? [];
    list.push(dto);
    shotsByScene.set(s.scene_id, list);
  }

  // 第二遍：依据全部镜头状态推导前置就绪情况与可拍状态
  for (const shot of shotById.values()) {
    const prereqs: ShotPrereqDto[] = [];
    for (const depId of shot.prereqIds) {
      const dep = shotById.get(depId);
      if (!dep) continue; // 前置镜头已被删除（外键级联正常情况下不会发生，防御性跳过）
      prereqs.push({
        shotId: dep.id,
        shotNo: dep.shotNo,
        required: dep.required,
        status: dep.status,
        reshootReason: dep.reshootReason,
        satisfied: dep.status === 'done',
      });
    }
    shot.prereqs = prereqs;
    shot.blockedBy = prereqs.filter((p) => !p.satisfied);
    shot.shootable = shot.blockedBy.length === 0;
  }

  const totals: ShotListReport['totals'] = {
    scenes: 0,
    completeScenes: 0,
    scenesWithoutShots: 0,
    shots: 0,
    requiredShots: 0,
    doneShots: 0,
    requiredDone: 0,
    pendingShots: 0,
    reshootShots: 0,
    shootableShots: 0,
  };

  const scenes: SceneShotsDto[] = [];
  for (const sc of sceneRows) {
    if (sceneIdFilter > 0 && sc.id !== sceneIdFilter) continue;
    const shots = shotsByScene.get(sc.id) ?? [];
    const doneShots = shots.filter((s) => s.status === 'done').length;
    const requiredShots = shots.filter((s) => s.required).length;
    const requiredDone = shots.filter((s) => s.required && s.status === 'done').length;
    const pendingShots = shots.filter((s) => s.status === 'pending').length;
    const reshootShots = shots.filter((s) => s.status === 'reshoot').length;
    const complete = shots.length > 0 && requiredDone === requiredShots;
    // 下一批可拍队列：可拍且未完成，必拍优先、镜头编号自然序（id 兜底保证确定性）
    const queue = shots
      .filter((s) => s.shootable && s.status !== 'done')
      .sort(
        (a, b) =>
          Number(b.required) - Number(a.required) ||
          naturalShotNoCompare(a.shotNo, b.shotNo) ||
          a.id - b.id
      )
      .map((s) => s.id);
    scenes.push({
      sceneId: sc.id,
      title: sc.title,
      storyTime: sc.story_time,
      seq: sc.seq,
      storyIndex: storyIndex.get(sc.id)!,
      totalShots: shots.length,
      requiredShots,
      doneShots,
      requiredDone,
      pendingShots,
      reshootShots,
      completion: shots.length > 0 ? doneShots / shots.length : 0,
      complete,
      queue,
      shots,
    });

    totals.scenes += 1;
    if (complete) totals.completeScenes += 1;
    if (shots.length === 0) totals.scenesWithoutShots += 1;
    totals.shots += shots.length;
    totals.requiredShots += requiredShots;
    totals.doneShots += doneShots;
    totals.requiredDone += requiredDone;
    totals.pendingShots += pendingShots;
    totals.reshootShots += reshootShots;
    totals.shootableShots += queue.length;
  }

  return { generatedAt: new Date().toISOString(), scenes, totals };
}

/* ============================== 前置依赖校验 ============================== */

/**
 * 检测「为镜头 shotId 设置前置 newPrereqIds」是否会产生依赖环。
 * 现有图中 shotId 的出边会被整体替换为 newPrereqIds；
 * 产生环时返回闭环路径上的镜头 id（首尾相同，如 [A, B, C, A]），无环返回 null。
 */
export function findPrereqCycle(shotId: number, newPrereqIds: number[]): number[] | null {
  const rows = db
    .prepare('SELECT shot_id, dep_shot_id FROM shot_deps WHERE shot_id <> ?')
    .all(shotId) as unknown as DepRow[];
  const adj = new Map<number, number[]>();
  for (const r of rows) {
    const list = adj.get(r.shot_id) ?? [];
    list.push(r.dep_shot_id);
    adj.set(r.shot_id, list);
  }
  adj.set(shotId, [...new Set(newPrereqIds)]);

  // 从 shotId 沿「依赖于」边深度优先，寻找回到 shotId 的路径
  const visited = new Set<number>();
  const onPath = new Set<number>([shotId]);
  const path: number[] = [shotId];
  const dfs = (node: number): number[] | null => {
    for (const next of adj.get(node) ?? []) {
      if (next === shotId) return [...path, shotId];
      if (onPath.has(next) || visited.has(next)) continue;
      visited.add(next);
      onPath.add(next);
      path.push(next);
      const found = dfs(next);
      if (found) return found;
      path.pop();
      onPath.delete(next);
    }
    return null;
  };
  return dfs(shotId);
}

function shotNoOf(shotId: number): string {
  const row = db.prepare('SELECT shot_no FROM shots WHERE id = ?').get(shotId) as
    | { shot_no: string }
    | undefined;
  return row ? row.shot_no : `#${shotId}`;
}

/**
 * 校验为镜头设置的前置镜头列表（存在性 / 同场景 / 自依赖 / 任意深度环）。
 * 合法返回 null；否则返回可直接展示的错误信息（循环依赖附镜头编号闭环路径）。
 * 调用方应在事务内、任何写入之前执行本校验，失败即回滚，保证原关系不被部分写入。
 *
 * @param sceneId 镜头所属场景
 * @param shotId  被编辑的镜头 id；新建镜头传 null（新镜头尚无入边，不可能成环）
 * @param prereqIds 拟设置的前置镜头 id 列表
 */
export function checkShotPrereqs(
  sceneId: number,
  shotId: number | null,
  prereqIds: number[]
): string | null {
  const ids = [...new Set(prereqIds)];
  if (ids.length === 0) return null;

  if (shotId !== null && ids.includes(shotId)) {
    const no = shotNoOf(shotId);
    return `镜头 ${no} 不能以自己为前置镜头（闭环：${no} → ${no}）`;
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, shot_no, scene_id FROM shots WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as { id: number; shot_no: string; scene_id: number }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) return `前置镜头不存在（id=${id}），可能已被删除，请刷新后重试`;
    if (row.scene_id !== sceneId) {
      return `前置镜头「${row.shot_no}」属于其他场景，只能选择同场景的镜头作为前置`;
    }
  }

  if (shotId !== null) {
    const cycle = findPrereqCycle(shotId, ids);
    if (cycle) {
      const nos = cycle.map(shotNoOf);
      return `前置镜头构成循环依赖：${nos.join(' → ')}。请解除闭环后再保存`;
    }
  }
  return null;
}
