
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    manifest = json.load(f)
results = []
for item in manifest.get('cells', []):
    cell_id = item.get('cell_id')
    if cell_id == '0_0':
        text = '永'
    else:
        text = '口'
    results.append({
        'cell_id': cell_id,
        'row': item.get('row'),
        'col': item.get('col'),
        'target_char': item.get('target_char'),
        'recognized_char': text,
        'raw_text': text,
        'confidence': 0.99,
        'status': 'recognized'
    })
print(json.dumps({'supported': True, 'engine': 'MockOCR', 'results': results}, ensure_ascii=False))
