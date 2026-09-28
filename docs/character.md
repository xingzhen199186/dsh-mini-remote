# 鲸鱼娘形象设定（九张立绘共用）

2026-09-28 重立。起因：九张动画（每张两帧，共 18 帧）此前是**一张图里并排画两格**出的，
模型两格各画一遍同一个角色——裙子上的图案、袜口条纹、腿和发丝都会各差一点；后来用
`--freeze-below` 把第二帧的手臂以下整段取自第一帧去补，补丁落在腰上、胳膊上，于是又出现
「上半身和下半身割裂」「书举起来和举起前割裂」。用户 2026-09-28 拍板：**十八帧全部重画，
形象和动作由助手统一定制，姿势与角色定位不变**。

现在两帧不再同图生成：**先出第一帧，再由第一帧改出第二帧**（只改该动的那一处），
两帧出自同一张画，除该动的部位外天生逐像素一致。切图之后的下半身差异实测 ≤5%（跑、冲刺按
设计动腿，另算）。

## 一、服装（生成时逐字重复，别凭记忆重写）

| 部位 | 必须长这样 |
| --- | --- |
| 头饰 | 头顶正上方一枚**鲸鱼尾形状的结**（左右对称）；侧面一枚小的**鲸尾**发夹（只有尾鳍，不是整只鲸） |
| 头发 | 很长的冰蓝色（浅银蓝）波浪发，过腰，两侧长发丝贴着脸 |
| 眼睛 | 大而圆，蓝色；张嘴笑 |
| 领子 | **白色水手领**，边缘两道细藏青条纹，领口系一条藏青领结 |
| 袖子 | **白色长袖**，袖口宝蓝色滚边（两道细条纹） |
| 上衣 | **白色**水手衬衫——从领口到腰、连同后背**都是白的**，不是宝蓝马甲；领口系一条**中等矢车菊蓝**（`#5B7FC9`）的缎带蝴蝶结，**不要藏青深蓝** |
| 裙子 | **中等矢车菊蓝**（约 `#5B7FC9`，明显浅于藏青）；百褶有清楚的白色高光线，**裙摆下缘两道细白线**；腰上一道同色腰带压着一条细白线；**我们看过去的左半边一枚白色鲸尾图案**（只有尾鳍） |
| 袜子 | 白色及膝袜，袜口一道细蓝条纹 |
| 鞋 | 蓝色小皮鞋，白鞋底、细白鞋带，**鞋上没有蝴蝶结** |

比例：Q 版，约两个半头高，头大身子短。

**明确不要**：褶边裙、蕾丝、泡泡短袖、白色围裙式前襟、胸前大白蝴蝶结、袜子蕾丝褶口、
鞋上蝴蝶结、头饰偏在一侧、头发更蓬更卷、宝蓝色上衣（马甲式前襟）。

**底**：纯洋红 `#FF00FF` 平底，没有阴影、渐变、纹理、地面，也不要任何文字、水印、签名、格线。

## 二、九种姿势与两帧动作（2026-09-28 定；姿势与角色定位不得更改）

| 图 | 姿势 | 第一帧 | 第二帧 | 动的部位 |
| --- | --- | --- | --- | --- |
| `work-1-ready` | 待命 | 双手举过头顶欢呼 | 双手收到胸前交握 | 双臂＋肩 |
| `work-2-reading` | 读书 | 书捧在胸前、眼往下看、脸露着 | 书抬到下巴前，脸仍露在书上缘之上 | 双臂＋书 |
| `work-3-typing` | 打字 | 坐在小书桌前打键盘 | 略前倾、手再按下去一下 | 上身少许＋手 |
| `work-4-checking` | 检查 | 放大镜举到眼前看 | 放大镜略移开、头微转 | 手臂＋头 |
| `work-5-thinking` | 思考 | 双手交握在下巴前、眼往上看 | 手略低、眼神再往上一点 | 手＋眼神 |
| `work-6-running` | 跑 | 一膝抬到大腿近水平、脚提到膝高，另一腿伸直踩地，两臂在身侧摆 | 换边：另一条膝盖抬起、原来踩地的那条伸直 | 腿＋鞋＋臂 |
| `work-7-waiting` | 等太久 | 捧着杯子、肩微塌、低头看杯子 | 抬头、杯子略举 | 手＋头 |
| `work-8-sprinting` | 冲刺 | 弓身猛冲，一腿后蹬离地 | 换腿、身体再前倾、臂摆更大 | 腿＋上身＋臂 |
| `work-9-talking` | 说话 | 一只手举在头侧挥手、嘴张开 | 那只手落到肩高，仍在挥 | 单臂 |

## 三、出图工艺（2026-09-28 起）

1. **母版**：先用"待命第一帧"当参考出一张单人格的高清基准图（形象基准，见 `docs/` 同目录的
   历史记录或 `lib/art/out-canon.webp`）。九张的形象都照它，形象才统一。
2. **第一帧**：两张参考图——第一张给形象（母版），第二张给动作（该姿势旧图的第一帧，从
   `lib/art/work-N-*.webp` 左半格裁出来、铺在洋红底上、放大三倍）。
3. **第二帧**：只喂刚出的第一帧，提示词只描述**该动的那一处**，并写死"其余一律不动"。
4. **拼接与切图**：

       python tools/whale-pair.py 第一帧.png 第二帧.png 拼接.png
       python tools/whale-sprite.py 拼接.png lib/art/work-N-名字.webp

   注意：切图脚本的落点参照是 `lib/art/work-1-ready.webp`，所以**待命那张放到最后切**，
   或者接受"九张共用同一个参照"——两者不能混。

出图的直连工具是 `tools/whale-draw.py`（走 OpenRouter 的 `/images/generations`，参考图用
`input_references` 字段）。插件自带的 `edit_image` 在 OpenRouter 上没有可用的编辑路由
（它固定打 `/images/edits`，实测 404），所以别走它。单张约 2～3 美分。

### 第一帧的共享块（提示词原文，英文）

```
The FIRST reference image shows the character design to reuse; the SECOND reference image shows the POSE and ACTION to draw (ignore its two-panel layout, draw only one girl). Draw ONE single full-body girl on a flat solid pure magenta #FF00FF background filling the whole canvas: no shadow, no gradient, no floor, no border, no panel divider, no second character, no text, no watermark.

Character (keep exactly as in the first reference): a chibi anime girl with a big head and a short round body, about 2.5 head-heights tall, facing the viewer. Big round blue eyes, cheerful open smile. Very long wavy ice-blue hair (pale silvery blue) falling past her waist with long side locks framing her face. A blue WHALE-TAIL shaped bow ornament centred on top of her head, and a small WHALE-TAIL shaped hair clip (a tail fin only, not a whole whale) on the side of her hair. Outfit: a WHITE sailor blouse (the entire upper garment — collar to waist, front and back — is white, not blue); a WHITE sailor collar with two thin navy stripes; a medium cornflower-blue (#5B7FC9) ribbon bow at the front of the collar, never dark navy; long white sleeves with navy cuff trim; a pleated skirt in the same medium cornflower blue #5B7FC9 with clean white pleat highlight lines and TWO thin white stripes near the bottom hem; one WHITE WHALE-TAIL shaped emblem (a tail fin only) on the LOWER-LEFT of the skirt as we look at the image; white knee-high socks with a single thin blue stripe at the top; small blue shoes with white soles and a thin white strap, no bow on the shoes. No frills, no lace, no puffed sleeves, no white apron, no large white chest bow. Clean crisp anime line art with consistent soft shading, the same art style as the first reference. Character centred with a magenta margin all around, fully visible from the top of her hair to the soles of her shoes.

Pose for this image — {第二节表格里的"第一帧"那句，用英文描述}
```

### 第二帧的块

```
Take the reference image and change ONLY this: {第二节表格里的"第二帧"那句，用英文描述}.

Keep EVERYTHING else identical to the reference image: the same character, the same face and expression unless stated, the same hair and hair ornaments, the same outfit, the same colours, the same skirt with the same pleats, white stripes and whale-tail emblem in the same place, the same socks and shoes, the same scale, the same position in the canvas, the same flat pure magenta #FF00FF background, the same camera angle and the same lighting. Do NOT redesign, restyle or re-shade anything. {表格里的"动的部位"里除该动的以外，写明哪些不许动}. Output the same canvas size as the reference, still ONE single character on flat magenta, fully visible from the top of her hair to the soles of her shoes.
```

## 四、尺寸与验收（出图后按这个量，不用肉眼下结论）

- 一张图里并排两格；切图后合成 **760×330** 的 WebP（两帧并排，各 380×330），透明底。
- 人物高度 **310px**（±2%）；洋红抠底残留 **0**；离中缝 12px 内不透明像素 **0**（两格没挨太近）。
- 两帧"真的动过"的像素占比 **≥ 5%**（任一通道差 > 24）。本次实测 8.5%～28%。
- **光看占比不够，还要看剪影。** 占比高、但两帧的外轮廓差不多（例如两帧都是"抬起同一条腿"），
  播起来仍然像没动——手机上图小，两三像素的差别看不出来。跑那张 2026-09-28 就这样返工过一次：
  它的下半身帧间差有 52.8%，用户却说"腿部没有摆动起来"；改成一膝抬到大腿近水平、两帧换边
  之后（上半身差 62.7%）才读得出。判断办法：把两帧叠起来看外轮廓，或者把下半身裁出来放大并排看。
- **下半身不该动的姿势，裙子以下那一段差异要接近 0**。本次实测（成图第 240～330 行）：
  待命 0.6%、读书 0.5%、打字 2.1%、检查 5.4%、思考 0.7%、等太久 1.0%、说话 0.3%；
  跑 83.3%、冲刺 45.8%——这两张按设计动腿，不算缺陷。
- 比两帧差异**必须先要求两侧 alpha>128 再比颜色**，否则有损压缩在透明区留下的垃圾颜色值
  会被当成画面变化（2026-09-28 因此误报 2810 个差异）。
- 切图脚本两帧**共用**同一套裁切与缩放（外框取两帧并集），分别按各自外框裁会差一两个像素，
  播起来整个角色在抖（2026-09-21 实测过）。
- 拼接脚本 `tools/whale-pair.py` 另有一条自检：两帧各自的底必须都是纯洋红（四边非洋红占比
  ≤2%），否则不出图，让人重出而不是在这里硬抠。

## 五、历史：冻结修补（已作废，2026-09-28 重画后不再需要）

以下记录的是重画之前的补丁做法，**现在不要再用**；`tools/whale-sprite.py --freeze-below`
这个参数留在代码里没删，只是因为删它没有收益。

- 只动手臂的姿势，用 `--freeze-below 行号` 把该行以下整段取自第一帧（说话的这张取 168：
  手臂差异在 y164～167 收住）。
- 更早的八张裙摆不一致（源图已丢）用一次性工具 `tools/whale-freeze-band.py` 修补：切在图
  182～204 行之间挑"跨线差 ÷ 自然差"最小的一条，冻到"最后一行宽度还达最宽处 60%"处，
  上下各三行做渐变；这一段两帧轮廓差超过 45% 就跳过（跑、冲刺属于这一类）。
- 教训：这类补丁永远会留下接缝（上半身/下半身割裂、书举起来和举起前割裂），**根因是两格各画
  一遍，只能靠重画解决**。当时的数字与判别方法（领结/裙摆取样色差 ≤40、裙摆白线 ≥60 等）
  记录在 git 历史里，需要时翻 `git log -- docs/character.md`。

## 六、基准帧与改动画的规矩（2026-09-28 用户指定）

九张立绘在 2026-09-28 定稿（用户在手机上确认"所有动画都 OK"），当时的成品已冻结存档在
`docs/art-refs/2026-09-28/`：`frames/` 是九张雪碧图原样，`prompts/` 是全部提示词原文
（含没有被采用的中间版本），`README.md` 记着每张最终用的是哪一版提示词和实测数字。

**以后改动画，先跟那里的帧对照，不要凭记忆重画。** 具体四条：

1. 动手前把 `frames/` 里那一张调出来看，改完再并排比一遍。
2. 第二帧的提示词里要**列全这一帧该动的部位**，约束里只写"其余不动"。冲刺那轮写窄了
   （只准动腿和鞋），手臂被一起冻住，返工两次才补齐（腿＋鞋＋双臂＋头发）。
3. 用数字验收：帧间差异占比、按三段分的动的部位、腿的横向跨度（口径见第四节）。
4. 数字过了也要再看一眼成品图——这一轮的"步子太开""头发不摆"都是眼睛先看出来的。
