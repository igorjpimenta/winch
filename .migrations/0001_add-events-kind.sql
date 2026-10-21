-- events.kind: declared by producers at write time, read verbatim by the
-- emitter. Deliberately no backfill: notes are free text and can change, so
-- no migration rule may derive kinds from note content — a renamed note
-- would silently reclassify history. Pre-kind rows keep kind NULL and the
-- wire maps them by transition structure alone, exactly as they streamed
-- before this column existed. An append-only log keeps the meanings its
-- rows had when written.
ALTER TABLE `events` ADD `kind` text;
