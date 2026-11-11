import { useEffect, useState } from 'react';
import { Sheet } from '../../components/Sheet.tsx';
import { Button } from '../../components/Button.tsx';
import { FACILITY_KO, FAULT_KO } from '../../../shared/types.ts';
import type { Issue } from '../../api/index.ts';

export interface CompleteDialogProps {
  issue: Issue | null;
  saving: boolean;
  error?: string;
  onCancel: () => void;
  onSave: (file: File) => void;
}

export function CompleteDialog({ issue, saving, error, onCancel, onSave }: CompleteDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    setFile(null);
  }, [issue?.id]);
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <Sheet open={!!issue} title="처리 완료로 바꿀게요" onClose={saving ? undefined : onCancel}>
      {issue && (
        <div className="ad-dialog">
          <p className="ad-dialog__ctx">
            <strong>{issue.receiptNo}</strong> · {FACILITY_KO[issue.facility]} {FAULT_KO[issue.fault]} · {issue.addressLabel}
          </p>
          <label className={`ad-drop${file ? ' ad-drop--has' : ''}`}>
            <input
              type="file"
              accept="image/*"
              data-testid="admin-complete-photo"
              aria-label="고친 뒤 찍은 사진 고르기"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {preview ? (
              <img src={preview} alt="올린 완료 사진" />
            ) : (
              <>
                <span className="ad-drop__strong">고친 뒤 찍은 사진을 올려 주세요</span>
                <span className="ad-drop__sub">신고한 분께 이 사진이 함께 보여요</span>
              </>
            )}
          </label>
          {!file && <p className="ad-reason" id="ad-reason">완료 사진이 있어야 저장할 수 있어요</p>}
          {error && <p className="ad-err" role="alert">{error}</p>}
          <div className="ad-actions">
            <Button variant="secondary" size="md" onClick={onCancel} disabled={saving}>취소</Button>
            <Button
              variant="primary"
              size="md"
              data-testid="admin-save"
              disabled={!file}
              loading={saving}
              aria-describedby={file ? undefined : 'ad-reason'}
              onClick={() => file && onSave(file)}
            >
              완료로 저장
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
