#!/bin/bash
# 杭州电信 QPS 测试 - hi.eminet.ggff.net
ENDPOINT="https://hi.eminet.ggff.net/dns-query"

# 生成 DNS 查询 (example.com A)
printf '\x00\x00\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01' > /tmp/dns.bin

echo "======================================================"
echo " 机器: $(hostname) | IP: $(hostname -I 2>/dev/null | awk '{print $1}')"
echo " 时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo " 端点: $ENDPOINT"
echo "======================================================"

echo ""
echo "===== [1] 污染检测 ====="
for q in google.com youtube.com facebook.com x.com; do
  python3 -c "
import struct,sys
q='$q'
name=b''.join(bytes([len(p)])+p.encode() for p in q.split('.'))+b'\x00'
sys.stdout.buffer.write(struct.pack('>HHHHHH',0x1234,0x0100,1,0,0,0)+name+struct.pack('>HH',1,1))
" > /tmp/dns_q.bin
  RESULT=$(timeout 20 curl -s -X POST "$ENDPOINT" -H "Content-Type: application/dns-message" --data-binary @/tmp/dns_q.bin 2>/dev/null | python3 -c "
import sys,struct
data=sys.stdin.buffer.read()
if len(data)<12: print('无响应/响应过短'); sys.exit()
flags=struct.unpack('>H',data[2:4])[0]
ancount=struct.unpack('>H',data[6:8])[0]
rcode=flags&0xF
off=12
while data[off]!=0: off+=1+data[off]
off+=5
ips=[]
for i in range(ancount):
    if (data[off]&0xC0)==0xC0: off+=2
    else:
        while data[off]!=0: off+=1+data[off]
        off+=1
    rtype=struct.unpack('>H',data[off:off+2])[0]; off+=2
    rclass=struct.unpack('>H',data[off:off+2])[0]; off+=2
    ttl=struct.unpack('>I',data[off:off+4])[0]; off+=4
    rdlen=struct.unpack('>H',data[off:off+2])[0]; off+=2
    if rtype==1 and rdlen==4:
        ips.append('.'.join(str(b) for b in data[off:off+4]))
    off+=rdlen
rcode_name={0:'NOERROR',1:'FORMERR',2:'SERVFAIL',3:'NXDOMAIN'}.get(rcode,f'RCODE{rcode}')
print(f'rcode={rcode_name} answers={ancount} ips={ips}')
" 2>/dev/null || echo "查询失败")
  echo "  $q => $RESULT"
done

echo ""
echo "===== [2] 单线程 QPS (50 请求) ====="
START=$(date +%s%N)
OK=0
FAIL=0
for i in $(seq 1 50); do
  CODE=$(timeout 30 curl -s -o /dev/null -w "%{http_code}" -X POST "$ENDPOINT" -H "Content-Type: application/dns-message" --data-binary @/tmp/dns.bin 2>/dev/null)
  if [ "$CODE" = "200" ]; then OK=$((OK+1)); else FAIL=$((FAIL+1)); fi
done
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
QPS=$(awk "BEGIN{printf \"%.2f\", $OK * 1000 / $ELAPSED_MS}")
echo "  总耗时: ${ELAPSED_MS}ms | 成功: $OK | 失败: $FAIL"
echo "  单线程 QPS: $QPS"

echo ""
echo "===== [3] 多线程 QPS (100 请求, 10 并发) ====="
START=$(date +%s%N)
seq 1 100 | xargs -P 10 -I{} curl -s -o /dev/null -w "%{http_code}\n" -X POST "$ENDPOINT" -H "Content-Type: application/dns-message" --data-binary @/tmp/dns.bin > /tmp/qps_codes.txt 2>/dev/null
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
OK=$(grep -c "^200$" /tmp/qps_codes.txt)
FAIL=$(grep -vc "^200$" /tmp/qps_codes.txt)
QPS=$(awk "BEGIN{printf \"%.2f\", $OK * 1000 / $ELAPSED_MS}")
echo "  总耗时: ${ELAPSED_MS}ms | 成功: $OK | 失败: $FAIL"
echo "  多线程 QPS (10 并发): $QPS"
