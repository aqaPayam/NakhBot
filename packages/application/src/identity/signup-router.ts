import type { SignupState } from '@nakh/contracts';

import type { LocalizedIntent } from '../presentation.js';

export type SignupView = Readonly<{
  currentStep: SignupState['currentStep'];
  draftVersion: number;
  prompt: LocalizedIntent;
}>;

export function routeSignup(state: SignupState): SignupView {
  return {
    currentStep: state.currentStep,
    draftVersion: state.draftVersion,
    prompt: { key: `signup.${state.currentStep}.prompt`, variables: {} },
  };
}
