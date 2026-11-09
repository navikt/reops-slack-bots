"use client";

import { useEffect, useRef, useState } from "react";
import {
  BodyShort,
  Button,
  VStack,
  UNSAFE_Combobox as Combobox,
} from "@navikt/ds-react";
import {
  DEFAULT_HANDLED_EMOJIS,
  handledEmojiOptions,
  parseHandledEmojis,
} from "../../lib/handled-emojis";

export function HandledEmojiEditor({
  savedValue,
  busy,
  onSave,
}: {
  savedValue: string;
  busy: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState(() =>
    parseHandledEmojis(savedValue),
  );
  const [comboboxReset, setComboboxReset] = useState(0);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (refocus.current) {
      inputRef.current?.focus();
      refocus.current = false;
    }
  }, [comboboxReset]);
  useEffect(() => {
    setSelected(parseHandledEmojis(savedValue));
  }, [savedValue]);
  const options = handledEmojiOptions(selected);
  const search = input.trim().replace(/^:|:$/g, "").toLowerCase();
  const persist = async (next: string[], focusInput = false) => {
    if (busy || saving.current) return;
    const previous = selected;
    saving.current = true;
    setSelected(next);
    setInput("");
    setError(null);
    refocus.current = focusInput;
    setComboboxReset((value) => value + 1);
    try {
      if (!(await onSave(next.join(", ")))) {
        setSelected(previous);
        setError(
          "Could not save emojis. Your previous selection has been restored.",
        );
      }
    } finally {
      saving.current = false;
    }
  };
  const addNames = (value: string) => {
    if (busy || saving.current) return;
    try {
      void persist(parseHandledEmojis([...selected, value].join(", ")), true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid emoji name");
    }
  };
  return (
    <form
      style={{ width: "100%" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (input.trim()) addNames(input);
      }}
    >
      <VStack gap="space-12" align="start">
        <Combobox
          key={comboboxReset}
          ref={inputRef}
          label="Handled emojis"
          description="Type a Slack emoji name, such as :white_check_mark:, then press Enter. You can also paste a list. Remove individual emojis with ×. Changes save automatically and apply on the next scan."
          options={options}
          selectedOptions={options}
          filteredOptions={options.filter((option) =>
            option.value.toLowerCase().includes(search),
          )}
          isMultiSelect
          allowNewValues
          readOnly={busy}
          value={input}
          onChange={setInput}
          onToggleSelected={(option, isSelected) => {
            if (busy || saving.current) return;
            if (isSelected) addNames(option);
            else
              void persist(
                selected.filter((name) => name !== option),
                true,
              );
          }}
          onPaste={(e) => {
            e.preventDefault();
            addNames(e.clipboardData.getData("text"));
          }}
          error={error}
          style={{ width: "100%" }}
        />
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={busy}
          onClick={() => {
            if (busy || saving.current) return;
            void persist([...DEFAULT_HANDLED_EMOJIS]);
          }}
        >
          Reset to default
        </Button>
        <div role="status">
          {busy ? (
            <BodyShort size="small" textColor="subtle">
              Saving emojis…
            </BodyShort>
          ) : selected.length === 0 && !error ? (
            <BodyShort size="small" textColor="subtle">
              No handled emojis selected. Reaction-based handling is disabled.
            </BodyShort>
          ) : null}
        </div>
      </VStack>
    </form>
  );
}
