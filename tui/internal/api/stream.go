package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

/*
 * SSE：通知的实时流。
 *
 * ═════════════════════════════════════════
 * 断线补漏是这段代码的全部难点
 * ═════════════════════════════════════════
 *
 * 终端会被 Ctrl+Z 挂起、会被 SSH 断线、会被人合上笔记本。
 * 重连之后**必须**把断线期间的动静补上 —— 只从当前时刻往后收的话，
 * 那段时间里被 @ 的人永远不知道。
 *
 * 服务端那一侧写着同一句话：**漏掉的通知比没有通知更糟 ——
 * 它教会人不信任这个通道。**
 *
 * 补漏的挂点有两级，两级都要用上：
 *   ① 每个事件带一个 `id:`。重连时把它放进 `Last-Event-ID` 头，
 *      服务端从那一刻起回放
 *   ② 进程重启之后连头都没了 —— 那时候用 `?cursor=`，
 *      值是上一次收到的那个 id
 */

// Event 是流里的一条。
type Event struct {
	// sync / notification
	Name string
	// 服务端给的游标，重连时原样送回去
	ID   int64
	Data json.RawMessage
}

// Stream 连上一条 SSE，把事件送进 out。
//
// ─────────────────────────────────────────
// 它**自己重连**，而且退避
// ─────────────────────────────────────────
//
// 服务端每 15 分钟会主动断开一次（那是刻意的：被网络中间层
// 僵死的连接会一直占着订阅表）。所以「断开」是常态，不是故障 ——
// 报给用户没有意义，直接接上就好。
//
// 但退避是必须的：站挂了的时候，一个不退避的客户端会以
// 每秒一次的频率去敲一台已经起不来的服务器。
func Stream(ctx context.Context, c *Client, path string, cursor int64, out chan<- Event) {
	backoff := time.Second
	const maxBackoff = 30 * time.Second

	for {
		if ctx.Err() != nil {
			return
		}

		lastID, err := c.stream(ctx, path, cursor, out)
		if lastID > 0 {
			cursor = lastID
		}

		if ctx.Err() != nil {
			return
		}

		if err == nil {
			/*
			 * 干净地断开（服务端那 15 分钟的主动断连）——
			 * 立刻接上，不退避。退避的话人会有 15 秒收不到东西，
			 * 而那 15 秒里什么问题都没有。
			 */
			backoff = time.Second
		} else {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
	}
}

// stream 连一次。返回收到的最后一个事件 id。
func (c *Client) stream(ctx context.Context, path string, cursor int64, out chan<- Event) (int64, error) {
	url := c.BaseURL + path
	if cursor > 0 {
		url += "?cursor=" + strconv.FormatInt(cursor, 10)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", "ash/"+c.Version)
	if cursor > 0 {
		// 协议自带的那一级补漏。服务端从这一刻起回放
		req.Header.Set("Last-Event-ID", strconv.FormatInt(cursor, 10))
	}

	/*
	 * 这一次请求**不能用 c.HTTP** —— 那个客户端有 30 秒超时，
	 * 而一条 SSE 就是要挂着不动。
	 *
	 * 用它的话，每 30 秒断一次，而且断得像是网络故障。
	 */
	client := &http.Client{Timeout: 0}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, decodeError(resp)
	}

	var (
		lastID    int64
		eventName string
		dataLines []string
	)

	scanner := bufio.NewScanner(resp.Body)
	/*
	 * 默认的 64 KB 上限对一条通知够，但一条带长正文摘要的
	 * 可能顶上去 —— 而顶上去的表现是 scanner 直接停止，
	 * 也就是**流静默地死掉**。给到 1 MB。
	 */
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	flush := func() {
		if len(dataLines) == 0 {
			return
		}
		payload := strings.Join(dataLines, "\n")
		dataLines = nil
		name := eventName
		eventName = ""
		select {
		case out <- Event{Name: name, ID: lastID, Data: json.RawMessage(payload)}:
		case <-ctx.Done():
		}
	}

	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			// 空行 = 一个事件结束
			flush()
		case strings.HasPrefix(line, ":"):
			// 心跳。服务端每 25 秒发一次，穿透中间层的空闲超时
			continue
		case strings.HasPrefix(line, "id:"):
			if n, err := strconv.ParseInt(strings.TrimSpace(line[3:]), 10, 64); err == nil {
				lastID = n
			}
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimSpace(line[5:]))
		}
	}
	flush()
	return lastID, scanner.Err()
}
