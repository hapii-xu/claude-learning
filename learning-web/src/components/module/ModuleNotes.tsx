import { useState, useEffect } from 'react';
import { useProgress } from '@/hooks/useProgress';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Edit3, Save, X, StickyNote } from 'lucide-react';

const NOTES_KEY = 'claude-code-learning-notes';

interface Notes {
  [moduleId: string]: string;
}

function loadNotes(): Notes {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

function saveNotes(notes: Notes) {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch {
    // ignore
  }
}

export function ModuleNotes({ moduleId }: { moduleId: string }) {
  const [notes, setNotes] = useState<Notes>(loadNotes);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const note = notes[moduleId] || '';

  useEffect(() => {
    setDraft(note);
    setEditing(false);
  }, [moduleId, note]);

  const handleSave = () => {
    const updated = { ...notes, [moduleId]: draft.trim() };
    if (!draft.trim()) {
      delete updated[moduleId];
    }
    setNotes(updated);
    saveNotes(updated);
    setEditing(false);
  };

  const handleCancel = () => {
    setDraft(note);
    setEditing(false);
  };

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <StickyNote className="size-4 text-brand" />
            学习笔记
          </h3>
          {!editing && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setDraft(note);
                setEditing(true);
              }}
              title={note ? '编辑笔记' : '添加笔记'}
            >
              <Edit3 className="size-3.5" />
            </Button>
          )}
        </div>

        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="记录你对这个模块的理解、疑问或想法..."
              className="w-full h-24 rounded-md border bg-surface-0 px-3 py-2 text-sm resize-none outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/20 placeholder:text-muted-foreground"
              autoFocus
            />
            <div className="flex items-center gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                <X className="size-3.5" />
                取消
              </Button>
              <Button variant="brand" size="sm" onClick={handleSave}>
                <Save className="size-3.5" />
                保存
              </Button>
            </div>
          </div>
        ) : note ? (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">{note}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">点击编辑按钮添加个人学习笔记...</p>
        )}
      </CardContent>
    </Card>
  );
}
