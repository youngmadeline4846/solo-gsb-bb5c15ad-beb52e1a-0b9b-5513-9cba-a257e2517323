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
  };
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

/**
 * 镜头清单（纯读取现算）：
 * - 镜头状态由拍摄条推导：无条 = 待拍；有可用最佳条 = 已拍；其余 = 需重拍；
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

  const shotsByScene = new Map<number, ShotDto[]>();
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
    const list = shotsByScene.get(s.scene_id) ?? [];
    list.push({
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
      takes,
    });
    shotsByScene.set(s.scene_id, list);
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
  }

  return { generatedAt: new Date().toISOString(), scenes, totals };
}
