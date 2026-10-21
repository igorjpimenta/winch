ALTER TABLE `events` ADD `kind` text;--> statement-breakpoint
UPDATE `events` SET `kind`='gate.opened' WHERE `kind` IS NULL AND `note` LIKE 'gate open:%';
--> statement-breakpoint
UPDATE `events` SET `kind`='gate.resolved' WHERE `kind` IS NULL AND `note`='gate resume';
--> statement-breakpoint
UPDATE `events` SET `kind`='gate.dissolved' WHERE `kind` IS NULL AND `note` LIKE 'gate dissolved%';
--> statement-breakpoint
UPDATE `events` SET `kind`='gate.opened'
 WHERE `kind` IS NULL
   AND `to_status`='blocked'
   AND (`from_status`='todo' OR `from_status`='in_progress')
   AND `note` != 'blocked: max attempts'
   AND (
     EXISTS (
       SELECT 1 FROM `events` r
        WHERE r.`task_id` = `events`.`task_id`
          AND r.`note` = 'gate resume'
          AND r.`id` > `events`.`id`
          AND NOT EXISTS (
            SELECT 1 FROM `events` b
             WHERE b.`task_id` = `events`.`task_id`
               AND b.`to_status` = 'blocked'
               AND (b.`from_status` = 'todo' OR b.`from_status` = 'in_progress')
               AND b.`id` > `events`.`id` AND b.`id` < r.`id`
          )
     )
     OR (
       `task_id` IN (SELECT `id` FROM `tasks` WHERE `status`='blocked' AND `gate_type` IS NOT NULL)
       AND `id` = (
         SELECT MAX(e2.`id`) FROM `events` e2
          WHERE e2.`task_id` = `events`.`task_id`
            AND e2.`to_status` = 'blocked'
            AND (e2.`from_status` = 'todo' OR e2.`from_status` = 'in_progress')
       )
     )
   );
