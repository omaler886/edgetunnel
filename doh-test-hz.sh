#!/bin/bash
# 单次请求延迟测试
echo "--- 单次请求延迟 x5 ---"
for i in 1 2 3 4 5; do
  RESULT=$(timeout 30 curl -s -o /dev/null -w "conn:%{time_connect}s tls:%{time_appconnect}s total:%{time_total}s http:%{http_code}" -X POST "https://cf.foesaw.ggff.net/sync" -H "Content-Type: application/dns-message" --data-binary @/tmp/dns.bin 2>&1)
  if [ -z "$RESULT" ]; then
    echo "attempt $i: timeout/fail"
  else
    echo "attempt $i: $RESULT"
  fi
done

echo ""
echo "--- 单线程 QPS (50 请求) ---"
START=$(date +%s%N)
OK=0
FAIL=0
for i in $(seq 1 50); do
  CODE=$(timeout 30 curl -s -o /dev/null -w "%{http_code}" -X POST "https://cf.foesaw.ggff.net/sync" -H "Content-Type: application/dns-message" --data-binary @/tmp/dns.bin 2>/dev/null)
  if [ "$CODE" = "200" ]; then OK=$((OK+1)); else FAIL=$((FAIL+1)); fi
done
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
QPS=$(awk "BEGIN{printf \"%.2f\", $OK * 1000 / $ELAPSED_MS}")
echo "  总耗时: ${ELAPSED_MS}ms | 成功: $OK | 失败: $FAIL"
echo "  单线程 QPS: $QPS"

echo ""
echo "--- 多线程 QPS (100 请求, 10 并发) ---"
START=$(date +%s%N)
seq 1 100 | xargs -P 10 -I{} curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://cf.foesaw.ggff.net/sync" -H "Content-Type: application/dns-message" --data-binary @/tmp/dns.bin > /tmp/qps_codes.txt 2>/dev/null
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
OK=$(grep -c "^200$" /tmp/qps_codes.txt)
FAIL=$(grep -vc "^200$" /tmp/qps_codes.txt)
QPS=$(awk "BEGIN{printf \"%.2f\", $OK * 1000 / $ELAPSED_MS}")
echo "  总耗时: ${ELAPSED_MS}ms | 成功: $OK | 失败: $FAIL"
echo "  多线程 QPS (10 并发): $QPS"
