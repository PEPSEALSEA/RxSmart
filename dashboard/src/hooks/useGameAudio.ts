"use client";

import { useEffect, useRef, useState } from "react";
import {
  isGameAudioMuted,
  playSfx,
  setGameAudioMuted,
  unlockGameAudio,
} from "@/lib/game-audio";
import { SessionFeedback, SessionStatus } from "@/lib/pose-physics";

export function useGameAudio(feedback: SessionFeedback, enabled: boolean) {
  const prev = useRef<{ status: SessionStatus; rep: number; score: number } | null>(null);
  const missTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [muted, setMuted] = useState(isGameAudioMuted);

  useEffect(() => {
    if (!enabled) return;
    const p = prev.current;
    if (!p) {
      prev.current = { status: feedback.status, rep: feedback.rep, score: feedback.score };
      return;
    }

    if (p.status === "idle" && feedback.status === "moving") {
      void unlockGameAudio().then(() => playSfx("start"));
    }
    if (p.status !== "holding" && feedback.status === "holding") {
      playSfx("hold");
    }
    if (p.status === "holding" && feedback.status === "moving") {
      if (missTimer.current) clearTimeout(missTimer.current);
      missTimer.current = setTimeout(() => {
        if (prev.current?.status === "moving") playSfx("miss");
      }, 400);
    }
    if (feedback.rep > p.rep) {
      playSfx("rep");
    }
    if (p.status !== "complete" && feedback.status === "complete") {
      playSfx("complete");
    }

    prev.current = { status: feedback.status, rep: feedback.rep, score: feedback.score };
  }, [enabled, feedback.rep, feedback.score, feedback.status]);

  useEffect(() => {
    return () => {
      if (missTimer.current) clearTimeout(missTimer.current);
    };
  }, []);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setGameAudioMuted(next);
  };

  return { muted, toggleMute };
}
