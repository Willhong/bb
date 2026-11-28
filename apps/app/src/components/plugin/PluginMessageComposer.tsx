import { useContext, useMemo, useRef, useState } from "react";
import type { ExperimentalMessageComposerProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@bb/shared-ui/icon";
import { toProviderPickerOption } from "@/components/pickers/model-brand-prefix";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { PluginContext } from "./plugin-context";
import {
  ComposerBox,
  type PromptBoxHandle,
  type TypeaheadConfig,
} from "@/components/promptbox/ComposerBox";
import { ExecutionControls } from "@/components/promptbox/ExecutionControls";
import { usePromptVoice } from "@/components/promptbox/usePromptVoice";
import {
  sendPromptDraft,
  usePromptDraftController,
} from "@/hooks/usePromptDraftStorage";

const textTypeahead: TypeaheadConfig = {
  mention: {
    triggers: [],
    source: { projectId: undefined, environmentId: null },
  },
  command: {
    source: {
      projectId: undefined,
      providerId: undefined,
      commandScope: "thread",
      skillsTriggers: [],
      environmentId: null,
    },
  },
};

function MessageProviderIcon({ className }: { className?: string }) {
  return <Icon name="AiBrain01" className={className} />;
}

export function PluginMessageComposer({
  draftKey,
  placeholder,
  models,
  provider,
  providerCatalog,
  catalogNotice,
  experimental_catalogFooter,
  selection,
  onSelectionChange,
  disabledReason,
  onSubmit,
  onStop,
}: ExperimentalMessageComposerProps) {
  const pluginId = useContext(PluginContext);
  const key = JSON.stringify(["message", pluginId, draftKey]);
  const draft = usePromptDraftController({ kind: "plugin-new-thread", key });
  const store = useMemo(
    () => ({
      getCurrent: draft.getCurrent,
      subscribeDraft: draft.subscribe,
      setDraft: draft.setDraft,
    }),
    [draft],
  );
  const box = useRef<PromptBoxHandle>(null);
  const voice = usePromptVoice(box, draft, key, true);
  const submitting = useRef(false);
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const providers = useSystemProviders({
    enabled: provider !== undefined || providerCatalog !== undefined,
  }).data;
  const providerOptions = useMemo(() => {
    const choices = (providers ?? []).map(toProviderPickerOption);
    const options = choices.map((option) => {
      const reason = providerCatalog?.availability[option.value];
      return reason === null
        ? option
        : {
            ...option,
            disabled: true,
            disabledReason: reason ?? "이 대화에서 사용할 수 없는 provider",
          };
    });
    if (provider) {
      const index = choices.findIndex(({ value }) => value === provider.id);
      const localOption = {
        value: provider.id,
        label: provider.label,
        brandPrefix: provider.brandPrefix,
        icon: choices[index]?.icon ?? MessageProviderIcon,
      };
      if (index < 0) options.push(localOption);
      else options[index] = localOption;
    }
    return options;
  }, [provider, providerCatalog, providers]);
  const selected = models.find(({ id }) => id === selection.model);
  const selectionError = !selected
    ? "Choose an available model."
    : selection.reasoningLevel &&
        !selected.reasoningLevels?.some(
          ({ value }) => value === selection.reasoningLevel,
        )
      ? "Choose a reasoning level supported by this model."
      : undefined;
  const blocker = disabledReason ?? selectionError;

  async function submit() {
    if (
      submitting.current ||
      blocker ||
      voice.state === "recording" ||
      voice.state === "transcribing"
    )
      return;
    const current = draft.getCurrent();
    if (current.attachments.length || current.mentions.length) {
      setError(
        "Attachments and BB mentions are unavailable in this conversation. Remove them before sending.",
      );
      return;
    }
    if (!current.text.trim()) return;
    submitting.current = true;
    setSubmitting(true);
    setError("");
    try {
      await sendPromptDraft(draft, current, () =>
        onSubmit({ text: current.text, selection }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Message could not be sent.",
      );
    }
    submitting.current = false;
    setSubmitting(false);
  }

  return (
    <div
      className="w-full"
      onDragOverCapture={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDropCapture={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        setError("File attachments are unavailable in this conversation.");
      }}
      onPasteCapture={(event) => {
        if (!event.clipboardData.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        setError("File and image paste are unavailable. Paste text instead.");
      }}
    >
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <ComposerBox
        surface="thread"
        placeholder={placeholder}
        mentionMenuPlacement="top"
        draft={store}
        promptBoxRef={box}
        typeahead={textTypeahead}
        voice={voice}
        suppressPluginComposerCustomizations
        suppressPluginPlusMenu
        onSubmit={submit}
        submission={{
          title: "Submit (Enter)",
          isSubmitting,
          disabled: !!blocker,
          disabledReason: blocker,
          isRunning: !!onStop,
          onStop,
        }}
        executionControls={
          <ExecutionControls
            provider={{
              selectedId: providerCatalog?.selectedProviderId ?? provider?.id,
              onChange: providerCatalog?.onProviderChange,
              controlledCatalog: providerCatalog !== undefined,
              options: providerOptions,
              hasMultiple: providerOptions.length > 1,
            }}
            catalogNotice={catalogNotice}
            catalogFooter={experimental_catalogFooter}
            model={{
              selected: selection.model,
              options: models.map(({ id, label }) => ({ value: id, label })),
              moreOptions: [],
              isLoading: false,
              loadFailed: false,
              onChange: (model) => {
                const next = models.find(({ id }) => id === model);
                if (!next) return;
                const effort =
                  next.defaultReasoningLevel ??
                  next.reasoningLevels?.[0]?.value;
                onSelectionChange({
                  model,
                  ...(effort ? { reasoningLevel: effort } : {}),
                });
              },
            }}
            reasoning={{
              value: selection.reasoningLevel ?? "none",
              options: selected?.reasoningLevels ?? [],
              isLoading: false,
              onChange: (reasoningLevel) => {
                if (
                  selected?.reasoningLevels?.some(
                    ({ value }) => value === reasoningLevel,
                  )
                ) {
                  onSelectionChange({ ...selection, reasoningLevel });
                }
              },
            }}
          />
        }
      />
    </div>
  );
}
