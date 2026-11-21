import { fieldContract, type ViewCondition } from '@suzubase/shared-types';
import type { Field } from './api';

const operators = [
  ['eq', 'Equals'], ['ne', 'Does not equal'], ['empty', 'Is empty'], ['nonempty', 'Is not empty'],
  ['current-user', 'Current user'], ['current-user-group', 'Current user’s groups'],
] as const;

export function Conditions({ conditions, fields, onChange }: {
  conditions: ViewCondition[]; fields: Field[]; onChange: (conditions: ViewCondition[]) => void;
}) {
  const eligible = fields.filter(({ type }) => fieldContract[type].filter);
  function edit(index: number, fieldId: string, operator: ViewCondition['operator'], value = '') {
    const condition: ViewCondition = operator === 'eq' || operator === 'ne' ? { fieldId, operator, value } : { fieldId, operator };
    onChange(conditions.map((current, i) => i === index ? condition : current));
  }
  return <fieldset className="stack">
    <legend>Conditions (all must match)</legend>
    {conditions.map((condition, index) => {
      const field = eligible.find(({ fieldId }) => fieldId === condition.fieldId);
      return <div className="inline" key={index}>
        <label>Field <select aria-label="Condition field" value={condition.fieldId} onChange={(event) => edit(index, event.target.value, 'eq')}>
          {!field && <option value={condition.fieldId}>Missing field</option>}
          {eligible.map(({ fieldId, name }) => <option key={fieldId} value={fieldId}>{name}</option>)}
        </select></label>
        <label>Operator <select value={condition.operator} onChange={(event) =>
          edit(index, condition.fieldId, event.target.value as ViewCondition['operator'], 'value' in condition ? condition.value : '')}>
          {operators.filter(([key]) => key === 'current-user' ? field?.type === 'user' :
            key === 'current-user-group' ? field?.type === 'group' : true)
            .map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        {'value' in condition && <label>Value <input value={condition.value}
          onChange={(event) => edit(index, condition.fieldId, condition.operator, event.target.value)} /></label>}
        <button type="button" onClick={() => onChange(conditions.filter((_, i) => i !== index))}>Remove condition</button>
      </div>;
    })}
    <button type="button" disabled={!eligible.length || conditions.length >= 20}
      onClick={() => onChange([...conditions, { fieldId: eligible[0].fieldId, operator: 'eq', value: '' }])}>Add condition</button>
  </fieldset>;
}
