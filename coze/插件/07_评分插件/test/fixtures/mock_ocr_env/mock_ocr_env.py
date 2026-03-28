
import json, os, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    manifest = json.load(f)
results = []
for item in manifest.get('cells', []):
    results.append({
        'cell_id': item.get('cell_id'),
        'row': item.get('row'),
        'col': item.get('col'),
        'target_char': item.get('target_char'),
        'recognized_char': item.get('target_char'),
        'raw_text': item.get('target_char'),
        'confidence': 0.99,
        'status': 'recognized'
    })
print(json.dumps({
    'supported': True,
    'engine': 'MockOCR',
    'config': manifest.get('config'),
    'runtime': {
        'python_no_user_site': os.environ.get('PYTHONNOUSERSITE') == '1'
    },
    'results': results
}, ensure_ascii=False))
