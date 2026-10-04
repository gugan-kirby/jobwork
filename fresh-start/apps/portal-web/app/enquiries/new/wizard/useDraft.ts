'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Enquiry, EnquiryItemInput } from '@jobwork/contracts';
import { api, ApiError } from '../../../../lib/api';
import { INITIAL, fromEnquiry, toPayload, type DraftState } from './types';

export type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'failed';

/**
 * The draft's lifecycle, lifted out of the page (F-MX.6) so the three stages share one
 * truth. Three behaviours carry the weight here, unchanged from IN-05:
 *
 *  1. **Autosave states its result.** Every save carries the version the form was loaded
 *     at, and the save state is announced in a live region as well as shown — doc 21 §9
 *     asks for progress in text, not a spinner nobody can read.
 *  2. **A conflict is a conversation, not a silent overwrite.** Two people editing one
 *     draft (doc 19 §9) end with the second being told whose change they would lose and
 *     offered their colleague's version, rather than winning by keystroke order.
 *  3. **A failed submit points at the stage that is short.** Field paths from the 422
 *     are handed back so the page can mark the stage and jump there.
 */
export function useDraft(openedWithDraftId: string | null) {
  const [draft, setDraft] = useState<DraftState>(INITIAL);
  const [enquiryId, setEnquiryId] = useState<string | null>(openedWithDraftId);
  const [version, setVersion] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [conflictDetail, setConflictDetail] = useState<string | null>(null);
  const [resuming, setResuming] = useState(openedWithDraftId !== null);
  const dirty = useRef(false);

  const hydrate = useCallback((fresh: Enquiry): void => {
    setDraft(fromEnquiry(fresh));
    setEnquiryId(fresh.enquiryId);
    setVersion(fresh.aggregateVersion);
    setSaveState('saved');
    setConflictDetail(null);
    dirty.current = false;
  }, []);

  const save = useCallback(async (): Promise<Enquiry | null> => {
    setSaveState('saving');
    try {
      const saved = await api<Enquiry>(
        enquiryId ? `/enquiries/${enquiryId}/draft` : '/enquiries/draft',
        { method: 'POST', body: toPayload(draft, version) },
      );
      setEnquiryId(saved.enquiryId);
      setVersion(saved.aggregateVersion);
      setSaveState('saved');
      setConflictDetail(null);
      dirty.current = false;
      return saved;
    } catch (err) {
      if (err instanceof ApiError && err.problem.code === 'VERSION_CONFLICT') {
        setSaveState('conflict');
        setConflictDetail(err.problem.detail ?? err.problem.title);
        return null;
      }
      setSaveState('failed');
      setConflictDetail(err instanceof ApiError ? err.problem.detail ?? err.problem.title : null);
      return null;
    }
  }, [draft, enquiryId, version]);

  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => void save(), 1200);
    return () => clearTimeout(timer);
  }, [draft, save]);

  // Resuming what the URL names. Anything that navigates away — the documents library,
  // a reload, a closed tab — comes back to this same draft rather than a blank one.
  useEffect(() => {
    if (!openedWithDraftId) return;
    let cancelled = false;
    void api<{ draft: Enquiry | null }>(`/enquiries/${openedWithDraftId}`)
      .then((fresh) => {
        if (cancelled) return;
        if (fresh.draft) hydrate(fresh.draft);
        // Submitted, declined or someone else's: start clean rather than pretend.
        else setEnquiryId(null);
      })
      .catch(() => {
        if (!cancelled) setEnquiryId(null);
      })
      .finally(() => {
        if (!cancelled) setResuming(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrate, openedWithDraftId]);

  function edit(patch: Partial<DraftState>): void {
    dirty.current = true;
    setDraft((current) => ({ ...current, ...patch }));
  }

  function editItem(lineNo: number, patch: Partial<EnquiryItemInput>): void {
    dirty.current = true;
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.lineNo === lineNo ? { ...item, ...patch } : item)),
    }));
  }

  function update(mutate: (current: DraftState) => DraftState): void {
    dirty.current = true;
    setDraft(mutate);
  }

  async function reloadFromServer(): Promise<void> {
    if (!enquiryId) return;
    const fresh = await api<{ draft: Enquiry | null }>(`/enquiries/${enquiryId}`);
    if (fresh.draft) hydrate(fresh.draft);
  }

  const saveMessage =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? `Draft saved${version !== null ? ` (version ${version})` : ''}`
        : saveState === 'conflict'
          ? 'Not saved — someone else changed this draft'
          : saveState === 'failed'
            ? 'Not saved'
            : 'Not saved yet';

  return {
    draft,
    enquiryId,
    version,
    saveState,
    saveMessage,
    conflictDetail,
    resuming,
    edit,
    editItem,
    update,
    save,
    reloadFromServer,
  };
}

export type DraftApi = ReturnType<typeof useDraft>;
