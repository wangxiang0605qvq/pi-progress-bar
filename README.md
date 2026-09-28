# pi-progress-bar

pi 扩展：任务进度条。只要有任务在执行，就在输入框上方显示一条 0–100% 的进度条。

## 安装

### 方式一：作为 pi 包安装（推荐）

```bash
pi install git:github.com/wangxiang0605qvq/pi-progress-bar
```

### 方式二：手动复制

复制 `progress-bar.ts` 到 pi 扩展目录：

```bash
cp progress-bar.ts ~/.pi/agent/extensions/progress-bar.ts
```

然后 `/reload`。

## 行为

- 工具调用（bash / powershell 命令、文件读写等）执行期间显示。
- 模型生成回复期间显示「生成回复中」。
- 进度来源优先级：
  1. 命令输出里的百分比（curl / wget / pip / npm / huggingface 等打印的 `45%`）；
  2. bash 工具 `timeout` 参数，按「已用时间 / timeout」换算；
  3. 都没有时按已用时间平滑增长，最多 99%，避免空闲时假报完成。
- 任务结束瞬间补满 100%，停留 0.5 秒后消失。
- 多个任务并行时显示当前任务并标注 `+N`。

无命令、无配置项。

## 版权

著作权归作者所有，保留一切权利。详见 [LICENSE](LICENSE)。
