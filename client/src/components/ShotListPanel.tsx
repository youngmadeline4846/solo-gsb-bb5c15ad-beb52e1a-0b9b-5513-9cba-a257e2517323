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
 * 镜头清单：每个场景维护镜头（编号/景别/机位/必拍/备注）与多次拍摄结果（条）。
 * 场景完成度与状态由服务端现算；保存后经 run() 整体刷新，即时反映。
 */
export function ShotListPanel({ shotList, run }: Props) {
  const [filterScene, setFilterScene] = useState(0);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);

  if (!shotList) return <p className="muted">暂无数据</p>;

  const t = shotList.totals;
  const scenes = shotList.scenes.filter(
    (s) =>
      (filterScene === 0 || s.sceneId === filterScene) && (!onlyIncomplete || !s.complete)
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
        </div>
        <p className="muted small">
          镜头状态由拍摄条推导：无条 = 待拍；有「可用最佳条」= 已拍；其余 = 需重拍。
          只有场景内<b>所有必拍镜头均有可用最佳条</b>时，场景才标记为完成。
          本模块独立于连续性校验与拍摄排程，互不影响。
        </p>
      </section>

      <div className="panel-bar">
        <span className={`badge ${t.completeScenes === t.scenes && t.scenes > 0 ? 'badge-ok' : 'badge-warn'}`}>
          完成场景 {t.completeScenes}/{t.scenes}
        </span>
        <span className="badge badge-ok">已拍镜头 {t.doneShots}/{t.shots}</span>
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
        <SceneShotCard key={s.sceneId} scene={s} run={run} />
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

function SceneShotCard({ scene, run }: { scene: SceneShots; run: Props['run'] }) {
  const [draft, setDraft] = useState({ shotNo: '', framing: '', camera: '', required: true, note: '' });

  const cls = scene.complete
    ? 'shot-scene-complete'
    : scene.reshootShots > 0 || scene.totalShots === 0
      ? 'shot-scene-reshoot'
      : 'shot-scene-pending';

  const addShot = () =>
    run(async () => {
      await api.createShot(scene.sceneId, draft);
      setDraft({ shotNo: '', framing: '', camera: '', required: true, note: '' });
    });

  const pct = Math.round(scene.completion * 100);

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

      {scene.shots.map((shot) => (
        <ShotRow key={shot.id} shot={shot} run={run} />
      ))}

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

function ShotRow({ shot, run }: { shot: ShotItem; run: Props['run'] }) {
  const [draft, setDraft] = useState({
    shotNo: shot.shotNo,
    framing: shot.framing,
    camera: shot.camera,
    required: shot.required,
    note: shot.note,
  });

  useEffect(() => {
    setDraft({
      shotNo: shot.shotNo,
      framing: shot.framing,
      camera: shot.camera,
      required: shot.required,
      note: shot.note,
    });
  }, [shot]);

  const dirty =
    draft.shotNo !== shot.shotNo ||
    draft.framing !== shot.framing ||
    draft.camera !== shot.camera ||
    draft.required !== shot.required ||
    draft.note !== shot.note;

  const save = () => run(() => api.updateShot(shot.id, draft));
  const remove = () => {
    if (window.confirm(`删除镜头「${shot.shotNo}」？其全部拍摄条将一并删除。`)) {
      void run(() => api.deleteShot(shot.id));
    }
  };

  const bestTake = shot.takes.find((tk) => tk.id === shot.bestTakeId);

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
