import type { RecoveryEvent } from '../shared/model';
import type { ProgressionPlan } from '../shared/progression';
import { translate } from '../shared/i18n';

const recoveryKeys: Record<RecoveryEvent, string> = {
  turn: 'Recovery: New turn',
  'short-rest': 'Recovery: Short rest',
  'long-rest': 'Recovery: Long rest',
};
const progressionKeys: Record<ProgressionPlan['operation'], string> = {
  create: 'Creation: {name}',
  adopt: 'Start tracking progression: {name}',
  'level-up': 'Level up: {name}',
  respec: 'Rebuild: {name}',
};

/** Pending labels are persisted in English; rendering localizes the complete message. */
export const recoveryOperationLabel = (event: RecoveryEvent): string => translate(recoveryKeys[event], {}, 'en');
export const progressionOperationLabel = (operation: ProgressionPlan['operation'], name: string): string =>
  translate(progressionKeys[operation], { name }, 'en');
