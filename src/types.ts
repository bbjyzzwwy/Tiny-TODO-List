/**
 * Core data types for the Tiny TODO List extension.
 */

/** A single TODO item */
export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  groupId: string;
  createdAt: number;
}

/** A group that contains TODO items */
export interface TodoGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

/** The full application state persisted in the webview's local storage */
export interface TodoState {
  groups: TodoGroup[];
  items: TodoItem[];
}
