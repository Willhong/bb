// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { USER_MESSAGE_CHAR_CAP } from "@bb/client-core";
import { PluginMarkdown } from "./PluginMarkdown";

function renderMessage(role: "user" | "assistant", text: string) {
  const openFile = vi.fn();
  const view = render(
    <MemoryRouter>
      <RouteNavigationProvider>
        <ThreadTimelineNavigationProvider
          environmentId="env_parent"
          hostId="host_parent"
          threadId="thr_parent"
          workspaceRootPath="/private/parent"
          onOpenLocalFileLink={openFile}
          resolveMentionLink={() => null}
        >
          <PluginMarkdown
            experimental_chatMessage={{ role }}
            content={text}
            experimental_message={{
              id: "parent-message",
              threadId: "thr_parent",
              turnId: "parent-turn",
              projectId: "parent-project",
            }}
          />
        </ThreadTimelineNavigationProvider>
      </RouteNavigationProvider>
    </MemoryRouter>,
  );
  return { ...view, openFile };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("plugin-owned messages in native chat rows", () => {
  it("uses native user message expansion without inventing a thread or timestamp", () => {
    const { container } = renderMessage(
      "user",
      "x".repeat(USER_MESSAGE_CHAR_CAP + 50) + "THE_END",
    );
    expect(container.querySelector("[data-message-column]")).not.toBeNull();
    expect(container.textContent).not.toContain("THE_END");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(container.textContent).toContain("THE_END");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(container.textContent).not.toContain("THE_END");
    expect(container.querySelector("time")).toBeNull();
    expect(container.querySelectorAll("a[href*='/threads/']")).toHaveLength(0);
  });

  it("renders assistant Markdown with native copy and no thread operations", () => {
    const { container } = renderMessage(
      "assistant",
      "**A clear answer**\n\n- First result\n- Second result",
    );
    expect(screen.getByText("A clear answer").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Copy message" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(container.querySelector("time")).toBeNull();
  });

  it("does not inherit the surrounding thread host-file routing", () => {
    const { openFile } = renderMessage(
      "assistant",
      "![Diagram](/private/parent/diagram.png)",
    );
    expect(
      screen.getByRole("img", { name: "Diagram" }).getAttribute("src"),
    ).not.toContain("/api/v1/threads/");
    expect(openFile).not.toHaveBeenCalled();
  });
});
