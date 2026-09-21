@echo off
rem Forces Hibernate (S4) at midnight so career-ops-nightly-late (04:00,
rem WakeToRun) wakes the machine via the RTC wake-alarm path instead of
rem depending on Modern Standby (S0) wake, which this laptop does not wake
rem from reliably (confirmed: slept through the 04:00 trigger for 10h51m
rem on 2026-07-23/24 with no wake attempt logged).
rem Requires Hibernate to stay enabled (do not run `powercfg /hibernate off`).
echo %date% %time% - forcing hibernate >> "C:\Users\magee\OneDrive\Documents\career-ops\career-ops\tmp\hibernate-trigger.log"
shutdown /h
