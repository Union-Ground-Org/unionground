import type { ComponentType } from 'react';

// The system date and time dialog, loaded at first use as ReminderPicker does:
// Metro bundles the require, and the vitest transform never parses the
// package's Flow-typed source. Tests replace this module.
export type NativePickerEvent = { type?: string; nativeEvent?: { timestamp?: number } };
export type NativeDateTimePickerProps = {
  value: Date;
  mode: 'date' | 'time' | 'datetime';
  minimumDate?: Date;
  display?: 'default';
  onChange: (event: NativePickerEvent) => void;
};

let loaded: ComponentType<NativeDateTimePickerProps> | null | undefined;

export function loadNativeDateTimePicker(): ComponentType<NativeDateTimePickerProps> | null {
  if (loaded === undefined) {
    try {
      const module = require('@react-native-community/datetimepicker') as { default: ComponentType<NativeDateTimePickerProps> };
      loaded = module.default;
    } catch {
      // swallow-ok: a build without the native module shows the field's
      // "date picker unavailable" line instead.
      loaded = null;
    }
  }
  return loaded;
}
