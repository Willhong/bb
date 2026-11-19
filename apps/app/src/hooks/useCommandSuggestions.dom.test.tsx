// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptMentionCommandTrigger } from "@bb/domain";
import type { CommandListResponse } from "@bb/server-contract";
import { createDeferredPromise } from "@bb/test-helpers";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useCommandSuggestions } from "./useCommandSuggestions";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    projects: {
      commands: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useRealtimeSubscription")>()),
  useProjectDetailRealtimeSubscription: () => {},
}));

afterEach(() => {
  vi.clearAllMocks();
});

interface CommandQuery {
  trigger: PromptMentionCommandTrigger | null;
  text: string | null;
}

function renderCommandSuggestions(
  wrapper = createQueryClientTestHarness().wrapper,
) {
  const initialProps: CommandQuery = { trigger: null, text: null };
  return renderHook(
    ({ trigger, text }: CommandQuery) =>
      useCommandSuggestions({
        projectId: "project-1",
        providerId: "codex",
        commandScope: "thread",
        skillsTriggers: ["/", "$"],
        environmentId: "env-1",
        activeTrigger: trigger,
        query: text,
      }),
    { wrapper, initialProps },
  );
}

describe("useCommandSuggestions", () => {
  it("loads the catalog only once a command trigger is typed", async () => {
    const catalog = createDeferredPromise<CommandListResponse>();
    vi.mocked(sdk.projects.commands).mockReturnValue(catalog.promise);
    const { result, rerender } = renderCommandSuggestions();

    expect(sdk.projects.commands).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);

    rerender({ trigger: "/", text: "" });

    expect(sdk.projects.commands).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({
      isLoading: true,
      suggestions: [],
    });

    catalog.resolve({
      commands: [
        {
          name: "review",
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
      ],
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.suggestions.map(({ name }) => name)).toEqual([
      "review",
    ]);
  });

  it("shows the previous catalog at once when the composer returns after the default query cache window", async () => {
    vi.useFakeTimers();
    try {
      const { wrapper } = createQueryClientTestHarness({
        queries: { gcTime: 5 * 60_000 },
      });
      vi.mocked(sdk.projects.commands).mockResolvedValueOnce({
        commands: [
          {
            name: "review",
            source: "command",
            origin: "user",
            description: null,
            argumentHint: null,
          },
        ],
      });
      const first = renderCommandSuggestions(wrapper);
      first.rerender({ trigger: "/", text: "" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(first.result.current.suggestions.map(({ name }) => name)).toEqual(
        ["review"],
      );
      first.unmount();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });

      const refresh = createDeferredPromise<CommandListResponse>();
      vi.mocked(sdk.projects.commands).mockReturnValueOnce(refresh.promise);
      const second = renderCommandSuggestions(wrapper);
      second.rerender({ trigger: "/", text: "" });

      expect(sdk.projects.commands).toHaveBeenCalledTimes(2);
      expect(second.result.current).toMatchObject({
        isLoading: false,
        isRefreshing: true,
      });
      expect(
        second.result.current.suggestions.map(({ name }) => name),
      ).toEqual(["review"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
