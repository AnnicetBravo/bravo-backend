import re
content = open('server.js').read()
new_content = re.sub(
    r'const allowedOrigins.*?app\.use\(cors\(\{.*?\}\)\);',
    'app.use(cors());',
    content,
    flags=re.DOTALL
)
open('server.js', 'w').write(new_content)
print('Done')
print(new_content[:500])
