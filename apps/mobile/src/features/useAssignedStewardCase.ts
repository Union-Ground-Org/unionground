import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppProvider';
import { stewardCaseAssignment } from '../services/stewardCaseNote';
import { retireCaseDrafts } from './caseRetainedDrafts';

// #9091: whether the open case is assigned to this steward. The website gives a
// steward the case tools (note, step, deadlines) only in their own case dialog,
// so the phone asks the same question once per case and every steward case
// card follows the answer. Any failure answers no; each routine checks again.
// generation is the case screen's route-authorization generation: the
// question is asked again in each one, and an earlier one's answer is dropped.
//
// #9240 pull request E: the server's answer that the case is not this
// steward's (not a failure) is a loss of access, so it also retires every
// draft and attempt the case cards hold for the case (caseRetainedDrafts.ts).
export function useAssignedStewardCase(caseID: string | null, stewardID: string | null, generation: number): boolean {
  const [assigned, setAssigned] = useState(false);
  const app = useApp();
  // The context the answer is read in, for the retirement's key.
  const context = useRef(app);
  context.current = app;
  useEffect(() => {
    let active = true;
    setAssigned(false);
    if (!caseID || !stewardID) return () => { active = false; };
    void stewardCaseAssignment(caseID, stewardID)
      .then((answer) => {
        if (!active) return;
        if (answer === 'unassigned' && context.current.session?.user.id === stewardID) retireCaseDrafts(context.current, caseID);
        setAssigned(answer === 'assigned');
      })
      .catch(() => { if (active) setAssigned(false); });
    return () => { active = false; };
  }, [caseID, stewardID, generation]);
  return assigned;
}
