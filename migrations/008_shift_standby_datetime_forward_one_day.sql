SET @sql = IF(
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'spx_booking_history'),
  "UPDATE spx_booking_history
   SET standby_datetime = CASE
     WHEN CHAR_LENGTH(standby_datetime) = 16 THEN CONCAT(
       DATE_FORMAT(
         DATE_ADD(
           STR_TO_DATE(
             CONCAT(SUBSTRING(standby_datetime, 1, 6), LPAD(CAST(SUBSTRING(standby_datetime, 7, 4) AS UNSIGNED) - 543, 4, '0'), SUBSTRING(standby_datetime, 11)),
             '%d/%m/%Y %H:%i'
           ),
           INTERVAL 1 DAY
         ),
         '%d/%m/'
       ),
       YEAR(
         DATE_ADD(
           STR_TO_DATE(
             CONCAT(SUBSTRING(standby_datetime, 1, 6), LPAD(CAST(SUBSTRING(standby_datetime, 7, 4) AS UNSIGNED) - 543, 4, '0'), SUBSTRING(standby_datetime, 11)),
             '%d/%m/%Y %H:%i'
           ),
           INTERVAL 1 DAY
         )
       ) + 543,
       DATE_FORMAT(
         DATE_ADD(
           STR_TO_DATE(
             CONCAT(SUBSTRING(standby_datetime, 1, 6), LPAD(CAST(SUBSTRING(standby_datetime, 7, 4) AS UNSIGNED) - 543, 4, '0'), SUBSTRING(standby_datetime, 11)),
             '%d/%m/%Y %H:%i'
           ),
           INTERVAL 1 DAY
         ),
         ' %H:%i'
       )
     )
     WHEN CHAR_LENGTH(standby_datetime) = 19 THEN CONCAT(
       DATE_FORMAT(
         DATE_ADD(
           STR_TO_DATE(
             CONCAT(SUBSTRING(standby_datetime, 1, 6), LPAD(CAST(SUBSTRING(standby_datetime, 7, 4) AS UNSIGNED) - 543, 4, '0'), SUBSTRING(standby_datetime, 11)),
             '%d/%m/%Y %H:%i:%s'
           ),
           INTERVAL 1 DAY
         ),
         '%d/%m/'
       ),
       YEAR(
         DATE_ADD(
           STR_TO_DATE(
             CONCAT(SUBSTRING(standby_datetime, 1, 6), LPAD(CAST(SUBSTRING(standby_datetime, 7, 4) AS UNSIGNED) - 543, 4, '0'), SUBSTRING(standby_datetime, 11)),
             '%d/%m/%Y %H:%i:%s'
           ),
           INTERVAL 1 DAY
         )
       ) + 543,
       DATE_FORMAT(
         DATE_ADD(
           STR_TO_DATE(
             CONCAT(SUBSTRING(standby_datetime, 1, 6), LPAD(CAST(SUBSTRING(standby_datetime, 7, 4) AS UNSIGNED) - 543, 4, '0'), SUBSTRING(standby_datetime, 11)),
             '%d/%m/%Y %H:%i:%s'
           ),
           INTERVAL 1 DAY
         ),
         ' %H:%i:%s'
       )
     )
     ELSE standby_datetime
   END
   WHERE standby_datetime REGEXP '^[0-9]{2}/[0-9]{2}/[0-9]{4} [0-9]{2}:[0-9]{2}(:[0-9]{2})?$'",
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
