export type ViewCondition =
  | { fieldId: string; operator: 'eq' | 'ne'; value: string }
  | { fieldId: string; operator: 'empty' | 'nonempty' | 'current-user' | 'current-user-group' };

export interface SavedView {
  id: string;
  name: string;
  columns: { fieldId: string; width: number }[];
  conditions: ViewCondition[];
  sort?: { fieldId: string; direction: 'asc' | 'desc' };
}

export interface ViewConfiguration {
  views: SavedView[];
  defaultId: string | null;
}
