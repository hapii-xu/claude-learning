// 出于法律和安全考虑，我们通常只允许 Web Fetch 访问用户以某种形式提供的
// 域名。但对于一组与代码相关的预批准域名列表，我们做了例外处理。
//
// 安全警告：这些预批准域名仅适用于 WebFetch（仅限 GET 请求）。
// 沙箱系统有意不为网络限制继承此列表，因为对这些域的任意网络访问
//（POST、上传等）可能会造成数据渗出。huggingface.co、kaggle.com 和
// nuget.org 等域名允许文件上传，若允许不受限制的网络访问将非常危险。
//
// 参见 test/utils/sandbox/webfetch-preapproved-separation.test.ts，该测试
// 验证沙箱网络限制需要显式的用户权限规则。

export const PREAPPROVED_HOSTS = new Set([
  // Anthropic
  'platform.claude.com',
  'code.claude.com',
  'modelcontextprotocol.io',
  'github.com/anthropics',
  'agentskills.io',

  // 主流编程语言
  'docs.python.org', // Python
  'en.cppreference.com', // C/C++ 参考
  'docs.oracle.com', // Java
  'learn.microsoft.com', // C#/.NET
  'developer.mozilla.org', // JavaScript/Web APIs（MDN）
  'go.dev', // Go
  'pkg.go.dev', // Go 文档
  'www.php.net', // PHP
  'docs.swift.org', // Swift
  'kotlinlang.org', // Kotlin
  'ruby-doc.org', // Ruby
  'doc.rust-lang.org', // Rust
  'www.typescriptlang.org', // TypeScript

  // Web 与 JavaScript 框架/库
  'react.dev', // React
  'angular.io', // Angular
  'vuejs.org', // Vue.js
  'nextjs.org', // Next.js
  'expressjs.com', // Express.js
  'nodejs.org', // Node.js
  'bun.sh', // Bun
  'jquery.com', // jQuery
  'getbootstrap.com', // Bootstrap
  'tailwindcss.com', // Tailwind CSS
  'd3js.org', // D3.js
  'threejs.org', // Three.js
  'redux.js.org', // Redux
  'webpack.js.org', // Webpack
  'jestjs.io', // Jest
  'reactrouter.com', // React Router

  // Python 框架与库
  'docs.djangoproject.com', // Django
  'flask.palletsprojects.com', // Flask
  'fastapi.tiangolo.com', // FastAPI
  'pandas.pydata.org', // Pandas
  'numpy.org', // NumPy
  'www.tensorflow.org', // TensorFlow
  'pytorch.org', // PyTorch
  'scikit-learn.org', // Scikit-learn
  'matplotlib.org', // Matplotlib
  'requests.readthedocs.io', // Requests
  'jupyter.org', // Jupyter

  // PHP 框架
  'laravel.com', // Laravel
  'symfony.com', // Symfony
  'wordpress.org', // WordPress

  // Java 框架与库
  'docs.spring.io', // Spring
  'hibernate.org', // Hibernate
  'tomcat.apache.org', // Tomcat
  'gradle.org', // Gradle
  'maven.apache.org', // Maven

  // .NET 与 C# 框架
  'asp.net', // ASP.NET
  'dotnet.microsoft.com', // .NET
  'nuget.org', // NuGet
  'blazor.net', // Blazor

  // 移动开发
  'reactnative.dev', // React Native
  'docs.flutter.dev', // Flutter
  'developer.apple.com', // iOS/macOS
  'developer.android.com', // Android

  // 数据科学与机器学习
  'keras.io', // Keras
  'spark.apache.org', // Apache Spark
  'huggingface.co', // Hugging Face
  'www.kaggle.com', // Kaggle

  // 数据库
  'www.mongodb.com', // MongoDB
  'redis.io', // Redis
  'www.postgresql.org', // PostgreSQL
  'dev.mysql.com', // MySQL
  'www.sqlite.org', // SQLite
  'graphql.org', // GraphQL
  'prisma.io', // Prisma

  // 云计算与 DevOps
  'docs.aws.amazon.com', // AWS
  'cloud.google.com', // Google Cloud
  'learn.microsoft.com', // Azure
  'kubernetes.io', // Kubernetes
  'www.docker.com', // Docker
  'www.terraform.io', // Terraform
  'www.ansible.com', // Ansible
  'vercel.com/docs', // Vercel
  'docs.netlify.com', // Netlify
  'devcenter.heroku.com', // Heroku

  // 测试与监控
  'cypress.io', // Cypress
  'selenium.dev', // Selenium

  // 游戏开发
  'docs.unity.com', // Unity
  'docs.unrealengine.com', // Unreal Engine

  // 其他常用工具
  'git-scm.com', // Git
  'nginx.org', // Nginx
  'httpd.apache.org', // Apache HTTP Server
])

// 在模块加载时拆分一次，使常见的仅主机名查询走 O(1) Set.has()，
// 少量带路径前缀的条目（如 "github.com/anthropics"）回退到按主机名
// 维护的小型路径前缀列表。
const { HOSTNAME_ONLY, PATH_PREFIXES } = (() => {
  const hosts = new Set<string>()
  const paths = new Map<string, string[]>()
  for (const entry of PREAPPROVED_HOSTS) {
    const slash = entry.indexOf('/')
    if (slash === -1) {
      hosts.add(entry)
    } else {
      const host = entry.slice(0, slash)
      const path = entry.slice(slash)
      const prefixes = paths.get(host)
      if (prefixes) prefixes.push(path)
      else paths.set(host, [path])
    }
  }
  return { HOSTNAME_ONLY: hosts, PATH_PREFIXES: paths }
})()

export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true
  const prefixes = PATH_PREFIXES.get(hostname)
  if (prefixes) {
    for (const p of prefixes) {
      // 强制路径段边界："/anthropics" 不得匹配
      // "/anthropics-evil/malware"。仅允许精确匹配或前缀后紧跟 "/"。
      if (pathname === p || pathname.startsWith(p + '/')) return true
    }
  }
  return false
}
