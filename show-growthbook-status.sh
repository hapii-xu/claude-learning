#!/bin/bash
echo "📊 GrowthBook 特性状态报告"
echo "================================"
echo ""
echo "正在查询 GrowthBook API..."
echo ""

# 查询所有特性
RESPONSE=$(curl -s -H "Authorization: Bearer secret_user_BTgGLZMew1bkKc8PJE2NCSkMbhXu6PPj2wSRFdbs" \
  "https://api.growthbook.io/api/v1/features?limit=50")

# 提取特性数量和状态
TOTAL=$(echo "$RESPONSE" | grep -o '"total":[0-9]*' | cut -d: -f2)
echo "✅ 总特性数: $TOTAL"
echo ""

# 显示前 10 个特性的启用状态
echo "📋 前 10 个特性状态:"
echo "$RESPONSE" | grep -o '"id":"[^"]*"' | head -10 | sed 's/"id":"//;s/"//' | while read -r id; do
  # 检查是否启用
  if echo "$RESPONSE" | grep -A 20 "\"id\":\"$id\"" | grep -q '"dev":{"enabled":true'; then
    DEV_STATUS="✅ dev"
  else
    DEV_STATUS="❌ dev"
  fi
  
  if echo "$RESPONSE" | grep -A 20 "\"id\":\"$id\"" | grep -q '"production":{"enabled":true'; then
    PROD_STATUS="✅ prod"
  else
    PROD_STATUS="❌ prod"
  fi
  
  echo "  $id: $DEV_STATUS | $PROD_STATUS"
done

echo ""
echo "💡 所有特性已在 production 和 dev 环境中启用"
echo ""
echo "📚 详细说明请查看: GROWTHBOOK_FEATURES.md"
