// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createToaster, TOAST_CLASS, TOAST_ERROR_CLASS, TOAST_MS } from "../src/content/toast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

const toasts = () => document.querySelectorAll<HTMLElement>(`.${TOAST_CLASS}`);

it("shows one polite status message in <body> and hides it after a while", () => {
  const toaster = createToaster();
  toaster.show("Saved");
  expect(toasts()).toHaveLength(1);
  const toast = toasts()[0];
  expect(toast.parentElement).toBe(document.body);
  expect(toast.getAttribute("role")).toBe("status");
  expect(toast.getAttribute("aria-live")).toBe("polite");
  expect(toast.textContent).toBe("Saved");
  expect(toast.hidden).toBe(false);
  vi.advanceTimersByTime(TOAST_MS - 1);
  expect(toast.hidden).toBe(false);
  vi.advanceTimersByTime(1);
  expect(toast.hidden).toBe(true);
});

it("replaces the message showing, with a fresh time to live", () => {
  const toaster = createToaster();
  toaster.show("First", "error");
  vi.advanceTimersByTime(TOAST_MS - 1000);
  toaster.show("Second\nline two");
  expect(toasts()).toHaveLength(1);
  expect(toasts()[0].textContent).toBe("Second\nline two");
  expect(toasts()[0].classList.contains(TOAST_ERROR_CLASS)).toBe(false);
  vi.advanceTimersByTime(TOAST_MS - 1);
  expect(toasts()[0].hidden).toBe(false);
  vi.advanceTimersByTime(1);
  expect(toasts()[0].hidden).toBe(true);
});

it("marks errors, hides on a click and comes back if the page removed it", () => {
  const toaster = createToaster();
  toaster.show("Something failed", "error");
  expect(toasts()[0].classList.contains(TOAST_ERROR_CLASS)).toBe(true);
  toasts()[0].click();
  expect(toasts()[0].hidden).toBe(true);
  document.body.replaceChildren();
  toaster.show("Again");
  expect(toasts()).toHaveLength(1);
  expect(toasts()[0].hidden).toBe(false);
});
