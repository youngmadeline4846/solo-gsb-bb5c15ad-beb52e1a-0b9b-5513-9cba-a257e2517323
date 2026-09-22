import { useEffect, useState } from 'react';
import {
  api,
  type ReshootReason,
  type SceneShots,
  type ShotItem,
  type ShotListReport,
  type ShotStatus,
  type TakeItem,
} from '../api';

interface Props {
  shotList: ShotListReport | null;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}

const STATUS_LABEL: Record<ShotStatus, string> = {
  pending: '待拍',
  done: '已拍',
  reshoot: '需重拍',
};

const RESHOOT_LABEL: Record<ReshootReason, string> = {
  'no-best': '有可用条，但未选定最佳条',
  'best-ng': '最佳条被标记为不可用',
  'all-ng': '所有拍摄条均不可用',
};

const FRAMING_OPTIONS = ['大远景', '远景', '全景', '中景', '近景', '特写', '大特写'];
const CAMERA_OPTIONS = ['A 机 · 固定', 'B 机 · 固定', '手持', '轨道', '摇臂', '无人机', '斯坦尼康'];

/**
 * 镜头清单：每个场景维护镜头（编号/景别/机位/必拍/备注/前置镜头）与多次拍摄结果（条）。
 * 前置镜头全部有可用最佳条时镜头才「可拍」；场景顶部给出下一批可拍队列。
 * 状态、阻塞原因与队列均由服务端现算；保存后经 run() 整体刷新，即时反映。
 */
export function ShotListPanel({ shotList, run }: Props) {
  const [filterScene, setFilterScene] = useState(0);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [onlyShootable, setOnlyShootable] = useState(false);

  if (!shotList) return <p className="muted">暂无数据</p>;

  const t = shotList.totals;
  const scenes = shotList.scenes.filter(
    (s) =>
      (filterScene === 0 || s.sceneId === filterScene) &&
      (!onlyIncomplete || !s.complete) &&
      (!onlyShootable || s.queue.length > 0)
  );

  return (
    <div>
      <section className="card">
        <h3>镜头清单</h3>
        <div className="form-row">
          <label className="inline-field">
            按场景筛选
            <select value={filterScene} onChange={(e) => setFilterScene(Number(e.target.value))}>
              <option value={0}>全部场景</option>
              {shotList.scenes.map((s) => (
                <option key={s.sceneId} value={s.sceneId}>
                  #{s.storyIndex} {s.title}（{s.storyTime}）
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={onlyIncomplete}
              onChange={(e) => setOnlyIncomplete(e.target.checked)}
            />
            只看未完成场景
          </label>
          <label className="checkbox" title="只显示当前可拍（前置镜头均已有可用最佳条）且未完成的镜头">
            <input
              type="checkbox"
              checked={onlyShootable}
              onChange={(e) => setOnlyShootable(e.target.checked)}
            />
            只看可拍
          </label>
        </div>
        <p className="muted small">
          镜头状态由拍摄条推导：无条 = 待拍；有「可用最佳条」= 已拍；其余 = 需重拍。
          可为镜头选择<b>同场景的前置镜头</b>：全部前置都有可用最佳条时镜头才进入<b>可拍</b>，
          否则逐项列出阻塞原因；场景顶部按「必拍优先、镜头编号自然序」给出下一批可拍队列。
          只有场景内<b>所有必拍镜头均有可用最佳条</b>时，场景才标记为完成。
          本模块独立于连续性校验与拍摄排程，互不影响。
        </p>
      </section>

      <div className="panel-bar">
        <span className={`badge ${t.completeScenes === t.scenes && t.scenes > 0 ? 'badge-ok' : 'badge-warn'}`}>
          完成场景 {t.completeScenes}/{t.scenes}
        </span>
        <span className="badge badge-ok">已拍镜头 {t.doneShots}/{t.shots}</span>
        <span className={`badge ${t.shootableShots ? 'badge-ok' : 'badge-warn'}`}>
          🎬 可拍 {t.shootableShots}
        </span>
        <span className={`badge ${t.pendingShots ? 'badge-warn' : 'badge-ok'}`}>
          待拍 {t.pendingShots}
        </span>
        <span className={`badge ${t.reshootShots ? 'badge-danger' : 'badge-ok'}`}>
          需重拍 {t.reshootShots}
        </span>
        {t.scenesWithoutShots > 0 && (
          <span className="badge badge-danger">缺镜头场景 {t.scenesWithoutShots}</span>
        )}
        <span className="muted small">
          必拍进度 {t.requiredDone}/{t.requiredShots}
        </span>
      </div>

      {scenes.length === 0 && (
        <p className="muted">
          {shotList.scenes.length === 0
            ? '还没有场景，请先在「场景管理」中创建。'
            : '没有符合筛选条件的场景。'}
        </p>
      )}
      {scenes.map((s) => (
        <SceneShotCard key={s.sceneId} scene={s} onlyShootable={onlyShootable} run={run} />
      ))}

      <datalist id="framing-options">
        {FRAMING_OPTIONS.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <datalist id="camera-options">
        {CAMERA_OPTIONS.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </div>
  );
}

/* --------------------------------- 场景卡片 --------------------------------- */

function SceneShotCard({
  scene,
  onlyShootable,
  run,
}: {
  scene: SceneShots;
  onlyShootable: boolean;
  run: Props['run'];
}) {
  const [draft, setDraft] = useState({ shotNo: '', framing: '', camera: '', required: true, note: '' });

  const cls = scene.complete
    ? 'shot-scene-complete'
    : scene.reshootShots > 0 || scene.totalShots === 0
      ? 'shot-scene-reshoot'
      : 'shot-scene-pending';

  const addShot = () =>
    run(async () => {
      await api.createShot(scene.sceneId, { ...draft, prereqIds: [] });
      setDraft({ shotNo: '', framing: '', camera: '', required: true, note: '' });
    });

  const pct = Math.round(scene.completion * 100);
  const shotById = new Map(scene.shots.map((s) => [s.id, s]));
  const remaining = scene.totalShots - scene.doneShots;
  const queueSet = new Set(scene.queue);
  const visibleShots = onlyShootable
    ? scene.shots.filter((s) => queueSet.has(s.id))
    : scene.shots;

  return (
    <section className={`card shot-scene ${cls}`}>
      <div className="shot-scene-head">
        <span className="time-chip">
          {scene.storyTime}
          <em>同刻 #{scene.seq}</em>
        </span>
        <h3>{scene.title}</h3>
        <span className="muted small">故事 #{scene.storyIndex}</span>
        {scene.complete ? (
          <span className="badge badge-ok">✅ 场景完成</span>
        ) : scene.totalShots === 0 ? (
          <span className="badge badge-danger">⚠ 缺镜头：尚未建立任何镜头</span>
        ) : (
          <>
            <span className="badge badge-warn">必拍 {scene.requiredDone}/{scene.requiredShots}</span>
            {scene.pendingShots > 0 && (
              <span className="badge badge-warn">待拍 {scene.pendingShots}</span>
            )}
            {scene.reshootShots > 0 && (
              <span className="badge badge-danger">🔁 需重拍 {scene.reshootShots}</span>
            )}
          </>
        )}
        <span className="spacer" />
        <span className="muted small">
          {scene.totalShots === 0 ? '无镜头' : `完成度 ${pct}%（${scene.doneShots}/${scene.totalShots} 镜头）`}
        </span>
      </div>

      {scene.totalShots > 0 && (
        <div className="shot-progress" title={`完成度 ${pct}%`}>
          <div
            className={`shot-progress-fill ${scene.complete ? 'shot-progress-done' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {scene.queue.length > 0 && (
        <div className="shot-queue" title="可拍且未完成的镜头，按「必拍优先、镜头编号自然序」排列">
          <span className="shot-queue-label">🎬 下一批可拍</span>
          {scene.queue.map((id, i) => {
            const qs = shotById.get(id);
            if (!qs) return null;
            return (
              <span
                key={id}
                className={`shot-queue-chip ${qs.required ? 'shot-queue-required' : ''}`}
                title={qs.required ? '必拍镜头' : '非必拍镜头'}
              >
                {i + 1}. 镜头 {qs.shotNo}
                {qs.required ? ' ·必拍' : ''}
              </span>
            );
          })}
        </div>
      )}
      {scene.queue.length === 0 && remaining > 0 && (
        <div className="shot-queue shot-queue-empty">
          <span className="shot-queue-label">🎬 下一批可拍</span>
          <span className="muted small">
            暂无可拍镜头：剩余 {remaining} 个镜头均被前置镜头阻塞，逐项原因见下方各镜头。
          </span>
        </div>
      )}

      {visibleShots.map((shot) => (
        <ShotRow key={shot.id} shot={shot} sceneShots={scene.shots} run={run} />
      ))}
      {onlyShootable && visibleShots.length === 0 && scene.totalShots > 0 && (
        <p className="muted small">本场景当前没有可拍镜头。</p>
      )}

      <div className="form-row shot-add-form">
        <input
          placeholder="镜头编号，如 1、2A"
          style={{ maxWidth: 130 }}
          value={draft.shotNo}
          onChange={(e) => setDraft({ ...draft, shotNo: e.target.value })}
        />
        <input
          placeholder="景别，如 全景"
          list="framing-options"
          style={{ maxWidth: 120 }}
          value={draft.framing}
          onChange={(e) => setDraft({ ...draft, framing: e.target.value })}
        />
        <input
          placeholder="机位，如 A 机 · 固定"
          list="camera-options"
          style={{ maxWidth: 150 }}
          value={draft.camera}
          onChange={(e) => setDraft({ ...draft, camera: e.target.value })}
        />
        <label className="checkbox" title="必拍镜头：全部完成时场景才标记完成">
          <input
            type="checkbox"
            checked={draft.required}
            onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
          />
          必拍
        </label>
        <input
          placeholder="备注（可选）"
          value={draft.note}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        />
        <button className="primary" onClick={addShot} disabled={!draft.shotNo.trim()}>
          ＋ 添加镜头
        </button>
      </div>
    </section>
  );
}

/* --------------------------------- 镜头行 --------------------------------- */

function ShotRow({
  shot,
  sceneShots,
  run,
}: {
  shot: ShotItem;
  sceneShots: ShotItem[];
  run: Props['run'];
}) {
  const [draft, setDraft] = useState({
    shotNo: shot.shotNo,
    framing: shot.framing,
    camera: shot.camera,
    required: shot.required,
    note: shot.note,
    prereqIds: shot.prereqIds,
  });

  useEffect(() => {
    setDraft({
      shotNo: shot.shotNo,
      framing: shot.framing,
      camera: shot.camera,
      required: shot.required,
      note: shot.note,
      prereqIds: shot.prereqIds,
    });
  }, [shot]);

  const samePrereqs =
    draft.prereqIds.length === shot.prereqIds.length &&
    [...draft.prereqIds].sort((a, b) => a - b).join(',') ===
      [...shot.prereqIds].sort((a, b) => a - b).join(',');

  const dirty =
    draft.shotNo !== shot.shotNo ||
    draft.framing !== shot.framing ||
    draft.camera !== shot.camera ||
    draft.required !== shot.required ||
    draft.note !== shot.note ||
    !samePrereqs;

  const save = () => run(() => api.updateShot(shot.id, draft));
  const remove = () => {
    if (window.confirm(`删除镜头「${shot.shotNo}」？其全部拍摄条与前置依赖关系将一并删除。`)) {
      void run(() => api.deleteShot(shot.id));
    }
  };

  const bestTake = shot.takes.find((tk) => tk.id === shot.bestTakeId);
  const shotNoById = new Map(sceneShots.map((s) => [s.id, s.shotNo]));
  const addablePrereqs = sceneShots.filter(
    (s) => s.id !== shot.id && !draft.prereqIds.includes(s.id)
  );

  return (
    <div className={`shot-row shot-${shot.status}`}>
      <div className="shot-row-main">
        <div className="form-row">
          <input
            className="shot-no-input"
            title="镜头编号"
            value={draft.shotNo}
            onChange={(e) => setDraft({ ...draft, shotNo: e.target.value })}
          />
          <input
            placeholder="景别"
            list="framing-options"
            style={{ maxWidth: 110 }}
            value={draft.framing}
            onChange={(e) => setDraft({ ...draft, framing: e.target.value })}
          />
          <input
            placeholder="机位"
            list="camera-options"
            style={{ maxWidth: 140 }}
            value={draft.camera}
            onChange={(e) => setDraft({ ...draft, camera: e.target.value })}
          />
          <label className="checkbox" title="必拍镜头：全部完成时场景才标记完成">
            <input
              type="checkbox"
              checked={draft.required}
              onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
            />
            必拍
          </label>
          <input
            placeholder="备注（可选）"
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          />
          <span
            className={`badge ${
              shot.status === 'done'
                ? 'badge-ok'
                : shot.status === 'reshoot'
                  ? 'badge-danger'
                  : 'badge-warn'
            }`}
            title={shot.reshootReason ? RESHOOT_LABEL[shot.reshootReason] : undefined}
          >
            {STATUS_LABEL[shot.status]}
            {shot.status === 'done' && bestTake ? ` · 最佳第 ${bestTake.takeNo} 条` : ''}
          </span>
          {shot.status !== 'done' &&
            (shot.shootable ? (
              <span className="badge badge-ok" title="全部前置镜头均已有可用最佳条，可以开拍">
                🎬 可拍
              </span>
            ) : (
              <span
                className="badge badge-warn"
                title="存在尚未就绪的前置镜头，逐项原因见下方"
              >
                ⛔ 前置未就绪
              </span>
            ))}
          {shot.status === 'reshoot' && shot.reshootReason && (
            <span className="bad small">{RESHOOT_LABEL[shot.reshootReason]}</span>
          )}
          {!shot.required && <span className="muted small">（非必拍）</span>}
          <span className="spacer" />
          <button className="primary" onClick={save} disabled={!dirty || !draft.shotNo.trim()}>
            保存
          </button>
          <button className="danger" onClick={remove}>
            删除
          </button>
        </div>

        <div className="prereq-editor" title="前置镜头：仅同场景镜头；全部前置有可用最佳条后本镜头才可拍">
          <span className="muted small">前置镜头：</span>
          {draft.prereqIds.map((pid) => (
            <span key={pid} className="prereq-chip">
              镜头 {shotNoById.get(pid) ?? pid}
              <button
                className="ghost chip-x"
                title="移除该前置镜头"
                onClick={() =>
                  setDraft({ ...draft, prereqIds: draft.prereqIds.filter((x) => x !== pid) })
                }
              >
                ✕
              </button>
            </span>
          ))}
          {addablePrereqs.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const pid = Number(e.target.value);
                if (pid > 0) setDraft({ ...draft, prereqIds: [...draft.prereqIds, pid] });
              }}
            >
              <option value="">＋ 添加前置镜头…</option>
              {addablePrereqs.map((s) => (
                <option key={s.id} value={s.id}>
                  镜头 {s.shotNo}
                  {s.required ? '（必拍）' : ''}
                </option>
              ))}
            </select>
          )}
          {draft.prereqIds.length === 0 && addablePrereqs.length === 0 && (
            <span className="muted small">无（本场景暂无其他镜头可选）</span>
          )}
          {!samePrereqs && <span className="muted small">（前置未保存，点「保存」生效）</span>}
        </div>

        {shot.prereqs.length > 0 && (
          <div className="prereq-status">
            {shot.prereqs.map((p) => (
              <span
                key={p.shotId}
                className={`prereq-state ${p.satisfied ? 'prereq-state-ok' : 'prereq-state-blocked'}`}
              >
                {p.satisfied ? '✅' : '⛔'} 镜头 {p.shotNo} · {STATUS_LABEL[p.status]}
                {!p.satisfied && p.reshootReason ? `（${RESHOOT_LABEL[p.reshootReason]}）` : ''}
              </span>
            ))}
          </div>
        )}
        {!shot.shootable && (
          <div className="shot-blocked">
            ⛔ 暂不可拍，前置未就绪：
            {shot.blockedBy.map((b) => (
              <span key={b.shotId} className="shot-blocked-item">
                镜头 {b.shotNo}：{STATUS_LABEL[b.status]}
                {b.reshootReason ? `（${RESHOOT_LABEL[b.reshootReason]}）` : ''}
              </span>
            ))}
          </div>
        )}

        <div className="take-list">
          {shot.takes.map((tk) => (
            <TakeRow key={tk.id} take={tk} shotId={shot.id} run={run} />
          ))}
          {shot.takes.length === 0 && (
            <span className="muted small">尚未登记拍摄条。</span>
          )}
          <button
            className="ghost"
            onClick={() => run(() => api.addTake(shot.id, true, ''))}
            title="登记一次拍摄结果（条号自动递增）"
          >
            ＋ 登记第 {shot.takes.length + 1} 条
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- 拍摄条 --------------------------------- */

function TakeRow({
  take,
  shotId,
  run,
}: {
  take: TakeItem;
  shotId: number;
  run: Props['run'];
}) {
  const [note, setNote] = useState(take.note);

  useEffect(() => {
    setNote(take.note);
  }, [take]);

  const saveNoteIfChanged = () => {
    if (note !== take.note) void run(() => api.updateTake(take.id, take.usable, note));
  };

  return (
    <div className={`take-row ${take.isBest ? 'take-best' : ''} ${take.usable ? '' : 'take-ng'}`}>
      <span className="take-no">第 {take.takeNo} 条</span>
      <select
        value={take.usable ? '1' : '0'}
        onChange={(e) => run(() => api.updateTake(take.id, e.target.value === '1', note))}
        title="本条是否可用"
      >
        <option value="1">可用</option>
        <option value="0">NG</option>
      </select>
      <button
        className={`ghost take-star ${take.isBest ? 'take-star-on' : ''}`}
        title={take.isBest ? '取消最佳条' : '选为最佳条（每个镜头至多一条）'}
        onClick={() => run(() => api.setBestTake(shotId, take.isBest ? 0 : take.id))}
      >
        {take.isBest ? '★ 最佳条' : '☆ 设为最佳'}
      </button>
      <input
        placeholder="本条备注（可选）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={saveNoteIfChanged}
      />
      <button
        className="ghost"
        title="删除该条"
        onClick={() => run(() => api.deleteTake(take.id))}
      >
        ✕
      </button>
    </div>
  );
}
