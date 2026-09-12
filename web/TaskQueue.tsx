import { useEffect, useMemo, useState } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent, type Modifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { post } from './api.ts';
import type { Task } from './types.ts';
import { toast } from './lib.tsx';

export const TYPE_LABEL: Record<string, string> = {
  fix: 'Fix', feature: 'Feature', research: 'Research', marketing: 'Marketing', outreach: 'Outreach', support: 'Support', ops: 'Ops',
};

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

interface Props {
  tasks: Task[]; // the To do list, in server order
  base: string; // /companies/<slug>
  disabled: boolean; // another action is in flight
  running: boolean; // a task is running, so Run is unavailable
  onOpen: (id: number) => void;
  onRun: (t: Task) => void;
  onSaved: () => void | Promise<void>;
}

/** The To do queue. Drag the grip (or focus it and use Space + arrow keys) to reorder; the top task runs next. */
export function TaskQueue({ tasks, base, disabled, running, onOpen, onRun, onSaved }: Props) {
  const serverOrder = tasks.map((t) => t.id);
  const serverKey = serverOrder.join(',');
  const [order, setOrder] = useState(serverOrder);
  // While dragging or saving, don't let live updates yank the list out from under the pointer.
  const [holding, setHolding] = useState(false);
  useEffect(() => { if (!holding) setOrder(serverOrder); }, [serverKey, holding]);

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const rows = order.map((id) => byId.get(id)).filter((t): t is Task => Boolean(t));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) { setHolding(false); return; }
    const next = arrayMove(order, order.indexOf(Number(active.id)), order.indexOf(Number(over.id)));
    setOrder(next);
    try {
      await post(`${base}/tasks/reorder`, { ids: next });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error'); // list snaps back to the saved order below
    }
    await onSaved();
    setHolding(false);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalOnly]}
      onDragStart={() => setHolding(true)}
      onDragCancel={() => setHolding(false)}
      onDragEnd={(e) => void onDragEnd(e)}
      accessibility={{ screenReaderInstructions: { draggable: 'To reorder a task, press Space or Enter to pick it up, use the arrow keys to move it, then press Space or Enter to drop it. Press Escape to cancel.' } }}
    >
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <ul className="list tasks queue">
          {rows.map((t, i) => (
            <QueueRow key={t.id} t={t} first={i === 0} disabled={disabled} running={running} onOpen={onOpen} onRun={onRun} />
          ))}
        </ul>
      </SortableContext>
      <p className="queue-hint muted small">Drag <span aria-hidden>⠿</span> to reorder. The top task runs next.</p>
    </DndContext>
  );
}

function QueueRow({ t, first, disabled, running, onOpen, onRun }: {
  t: Task; first: boolean; disabled: boolean; running: boolean; onOpen: (id: number) => void; onRun: (t: Task) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`list-item clickable${isDragging ? ' dragging' : ''}`}
      onClick={() => onOpen(t.id)}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="drag-handle"
        aria-label={`Reorder task: ${t.title}`}
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
      >
        ⠿
      </button>
      <div className="grow">
        <div className="task-title">
          {first && <span className="badge next">Next up</span>}
          <span className={`badge type-${t.type}`}>{TYPE_LABEL[t.type] ?? t.type}</span>
          {t.priority === 1 && <span className="badge warn">High</span>}
          <strong>{t.title}</strong>
        </div>
        <p className="muted clamp small">{t.description}</p>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn small" disabled={disabled || running} title={running ? 'Another task is running' : ''} onClick={() => onRun(t)}>
          Run
        </button>
      </div>
    </li>
  );
}
