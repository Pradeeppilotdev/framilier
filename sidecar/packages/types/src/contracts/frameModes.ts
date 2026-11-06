import { Frame, FRAME_MODE, APPROVE_SCOPE } from "./FrameTx.js";

export const FRAME_SUBCLASS = {
  SELF_VERIFY: "self_verify",
  ONLY_VERIFY: "only_verify",
  PAY: "pay",
  EXPIRY_VERIFY: "expiry_verify",
  /** DEFAULT-mode frames are ambiguous between `deploy` and `post_op` by
   * mode/flags alone — EIP-8141 §Mode Subclassifications distinguishes
   * them by structural position (deploy must be first frame in the
   * validation prefix), not by any field on the frame itself. The
   * validation-prefix matcher (`recognizeValidationPrefix`) resolves this
   * ambiguity positionally. */
  DEPLOY_OR_POST_OP: "deploy_or_post_op",
  USER_OP: "user_op",
} as const;
export type FrameSubclass = (typeof FRAME_SUBCLASS)[keyof typeof FRAME_SUBCLASS];

export function classifyFrame(frame: Frame): FrameSubclass | null {
  const scope = frame.flags & APPROVE_SCOPE.EXECUTION_AND_PAYMENT;
  switch (frame.mode) {
    case FRAME_MODE.VERIFY:
      if (scope === APPROVE_SCOPE.EXECUTION_AND_PAYMENT) return FRAME_SUBCLASS.SELF_VERIFY;
      if (scope === APPROVE_SCOPE.EXECUTION) return FRAME_SUBCLASS.ONLY_VERIFY;
      if (scope === APPROVE_SCOPE.PAYMENT) return FRAME_SUBCLASS.PAY;
      return FRAME_SUBCLASS.EXPIRY_VERIFY;
    case FRAME_MODE.DEFAULT:
      return FRAME_SUBCLASS.DEPLOY_OR_POST_OP;
    case FRAME_MODE.SENDER:
      return FRAME_SUBCLASS.USER_OP;
    default:
      return null;
  }
}
