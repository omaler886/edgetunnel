#!/bin/bash
# 对比测试: 代理 vs CF官方 vs Google官方
N="${1:-100}"
THREADS="${2:-10}"

printf '\x00\x00\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01' > /tmp/dns.bin

echo "======================================================"
echo " 机器: $(hostname) | IP: $(hostname -I 2>/dev/null | awk '{print $1}')"
echo " 时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo " 请求数: $N | 并发: $THREADS"
echo "======================================================"

run_test() {
  local NAME="$1" URL="$2"
  echo ""
  echo "===== $NAME ====="
  echo "--- 延迟采样 x3 ---"
  for i in 1 2 3; do
    R=$(timeout 20 curl -s -o /dev/null -w "total:%{time_total}s" -X POST "$URL" -H "Content-Type: application/dns-message" --data-binary @/tmp/dns.bin 2>&1)
    [ -z "$R" ] && echo "  attempt $i: fail" || echo "  attempt $i: $R"
  done
  echo "--- 单线程 QPS ($N) ---"
  START=$(date +%s%N); OK=0; FAIL=0
  for i in $(seq 1 $N); do
    C=$(timeout 20 curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" -H "Content-Type: application/dns-message" --data-binary @/tmp/dns.bin 2>/dev/null)
    if [ "$C" = "200" ]; then OK=$((OK+1)); else FAIL=$((FAIL+1)); fi
  done
  END=$(date +%s%N); MS=$(( (END - START) / 1000000 ))
  Q=$(awk "BEGIN{printf \"%.2f\", $OK * 1000 / $MS}")
  echo "  耗时: ${MS}ms | 成功: $OK | 失败: $FAIL | QPS: $Q"
  echo "--- 多线程 QPS ($N, $THREADS并发) ---"
  START=$(date +%s%N)
  seq 1 $N | xargs -P $THREADS -I{} curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL" -H "Content-Type: application/dns-message" --data-binary @/tmp/dns.bin > /tmp/codes.txt 2>/dev/null
  END=$(date +%s%N); MS=$(( (END - START) / 1000000 ))
  OK=$(grep -c "^200$" /tmp/codes.txt); FAIL=$(grep -vc "^200$" /tmp/codes.txt)
  Q=$(awk "BEGIN{printf \"%.2f\", $OK * 1000 / $MS}")
  echo "  耗时: ${MS}ms | 成功: $OK | 失败: $FAIL | QPS: $Q"
}

run_test "Our Proxy | hi.eminet.ggff.net" "https://hi.eminet.ggff.net/dns-query"
run_test "Cloudflare | cloudflare-dns.com" "https://cloudflare-dns.com/dns-query"
run_test "Google | dns.google" "https://dns.google/dns-query"

echo ""
echo "===== Done ====="
