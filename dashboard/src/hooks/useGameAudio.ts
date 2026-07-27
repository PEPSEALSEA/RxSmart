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
  const prev = useRef<{
    status: SessionStatus;
    rep: number;
    score: number;
    phaseLabel: string;
  } | null>(null);
  const missTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const missArmed = useRef(false);
  const [muted, setMuted] = useState(isGameAudioMuted);

  useEffect(() => {
    if (!enabled) return;
    const p = prev.current;
    if (!p) {
      prev.current = {
        status: feedback.status,
        rep: feedback.rep,
        score: feedback.score,
        phaseLabel: feedback.phaseLabel,
      };
      return;
    }

    if (p.status === "idle" && feedback.status === "moving") {
      void unlockGameAudio().then(() => playSfx("start"));
    }
    if (p.status !== "holding" && feedback.status === "holding") {
      if (missTimer.current) clearTimeout(missTimer.current);
      missArmed.current = false;
      playSfx("hold");
    }

    // Successful hold → next phase: status holding→moving and phaseLabel changes.
    // Do NOT arm miss in that case.
    const phaseAdvanced =
      p.status === "holding" &&
      feedback.status === "moving" &&
      feedback.phaseLabel !== p.phaseLabel;

    if (p.status === "holding" && feedback.status === "moving" && !phaseAdvanced) {
      const activeBad = feedback.activeJoints.some((key) => {
        const jf = feedback.jointFeedback[key];
        return jf?.isActive && !jf.angleOk;
      });
      const reason = feedback.imuDiagnostics?.reason;
      const realMiss =
        activeBad ||
        reason === "wrong_board" ||
        reason === "speed" ||
        reason === "accel" ||
        reason === "delta_height";
      if (realMiss) {
        missArmed.current = true;
        if (missTimer.current) clearTimeout(missTimer.current);
        missTimer.current = setTimeout(() => {
          if (missArmed.current && prev.current?.status === "moving") playSfx("miss");
          missArmed.current = false;
        }, 400);
      }
    }

    if (feedback.rep > p.rep) {
      if (missTimer.current) clearTimeout(missTimer.current);
      missArmed.current = false;
      playSfx("rep");
    }
    if (p.status !== "complete" && feedback.status === "complete") {
      if (missTimer.current) clearTimeout(missTimer.current);
      missArmed.current = false;
      playSfx("complete");
    }
    if (feedback.status === "holding" || feedback.status === "rest" || phaseAdvanced) {
      if (missTimer.current) clearTimeout(missTimer.current);
      missArmed.current = false;
    }

    prev.current = {
      status: feedback.status,
      rep: feedback.rep,
      score: feedback.score,
      phaseLabel: feedback.phaseLabel,
    };
  }, [
    enabled,
    feedback.rep,
    feedback.score,
    feedback.status,
    feedback.phaseLabel,
    feedback.activeJoints,
    feedback.jointFeedback,
    feedback.imuDiagnostics,
  ]);

  useEffect(() => {
    if (!enabled || feedback.status !== "holding") return;
    const id = window.setInterval(() => playSfx("tick"), 900);
    return () => window.clearInterval(id);
  }, [enabled, feedback.status, feedback.phaseLabel]);

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
