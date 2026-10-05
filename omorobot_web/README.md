# omorobot_web

로봇 PC에서 웹 서버를 실행하고, 외부 PC·태블릿의 브라우저로 접속하여 매핑, 위치 포인트 등록, 맵 수정, Job(로봇 동작 프로그램) 작성·실행을 하는 패키지입니다.
모니터·키보드 없이 로봇을 사용할 수 있으며, 접속하는 PC에는 ROS 설치가 필요 없습니다.

## 실행

```bash
cd ~/ros2_ws && colcon build --symlink-install --packages-select omorobot_web
source ~/ros2_ws/install/setup.bash
ros2 launch omorobot_web web_launch.py
```

같은 네트워크의 PC에서 `http://<로봇 IP>:8080` 으로 접속합니다.

bringup, cartographer, navigation2 는 웹 화면의 조작에 따라 웹 서버가 자동으로 실행·종료하므로 따로 실행하지 않습니다.
SSH 터미널에서 이미 실행한 경우에는 "외부 실행"으로 인식하여 그대로 사용합니다.

| launch 인자 | 기본값 | 설명 |
|---|---|---|
| `port` | `8080` | 웹 서버 포트 |
| `host` | `0.0.0.0` | 접속을 받을 주소 |
| `data_dir` | `~/omorobot_web_data` | 맵, 포인트, Job 저장 위치 |
| `sim` | `false` | `true` 이면 실제 로봇 대신 가상 로봇 사용 |
| `sim_world` | (turtlebot3_world) | 가상 로봇이 주행할 맵 yaml |

### 로봇 없이 사용해 보기

```bash
ros2 launch omorobot_web web_launch.py sim:=true
```

가상 로봇(`fake_robot`)이 맵 이미지 안에서 주행하며 odom, tf, scan 을 발행합니다. cartographer 와 navigation2 는 실제와 동일하게 실행됩니다.

### 부팅 시 자동 실행

`systemd/omorobot-web.service` 파일 상단의 안내를 따릅니다.

## 화면 구성

왼쪽은 메뉴, 오른쪽은 선택한 메뉴의 화면입니다. 상단에는 로봇 상태와 **비상 정지** 버튼이 항상 표시됩니다.

| 메뉴 | 기능 |
|---|---|
| Job 프로그램 | 명령을 조합하여 Job 작성, 실행 / 일시 정지 / 정지, 실행 모니터 |
| 맵 생성 | 매핑 시작·종료, 실시간 맵 확인, 현재 위치를 포인트로 등록, 맵 저장, 맵 초기화 |
| 위치 포인트 | 정지 위치·경유점(waypoint) 추가·수정·삭제, 시작 위치 지정(전원을 켤 때 로봇을 두는 곳), 내비게이션 시작, 초기 위치 설정, 포인트로 이동 |
| 맵 수정 | 브러시·직선·사각형으로 벽(진입 금지)을 그리거나 노이즈 제거, 원본 복원 |
| 맵 관리 | 맵 이름 변경, 복제, 삭제, 다운로드, 기존 맵 파일(yaml + pgm) 가져오기 |
| 시스템 | 프로세스 상태·로그, I/O 상태와 이름 설정 |
| 가상 키보드 | 메뉴 아래 버튼으로 열고 닫음. W A S D X 키 또는 화면 버튼으로 로봇 조작. 최고 속도와 속도 증감 단위는 `ROBOT_MODEL` 에 따름 |

### 사용 순서

1. **맵 생성**: "매핑 시작" → 가상 키보드로 주행 → 맵 이름 입력 후 "맵 저장"
2. **위치 포인트**: 지도를 클릭(끌면 방향 지정)하여 포인트 등록
3. **맵 수정** (선택): 로봇이 들어가면 안 되는 곳에 벽을 그림
4. **Job 프로그램**: 맵을 선택하고 명령을 추가하여 저장 → "실행"

### 정지 위치의 허용 오차

포인트 편집에서 정지 위치마다 "위치 허용 오차 (cm)", "각도 허용 오차 (°)" 를 지정할 수 있습니다. 비워 두면 내비게이션 파라미터의 기본값(`general_goal_checker`, R2MINI: 10 cm / 0.1 rad)을 사용합니다.

- 웹 서버가 이동 명령 직전에 `controller_server` 의 goal checker 허용 오차를 바꾸고, 위치 허용 오차에 맞는 controller(`FollowPath`, `FollowPathFine`, `FollowPathCoarse`)를 선택합니다.
- 위치 허용 오차의 최솟값은 controller 중 가장 작은 `xy_goal_tolerance`(R2MINI: 5 cm)이며, 더 작게 입력하면 최솟값으로 이동합니다.
- controller 가 하나뿐인 파라미터 파일(R2, DONKEYBOTI)에서는 그 controller 의 `xy_goal_tolerance` 가 최솟값입니다.
- 경유점은 멈추지 않고 통과하므로 허용 오차는 마지막 정지 위치에만 적용됩니다.

### Job 명령

| 명령 | 설명 |
|---|---|
| 이동 (MOVE) | 포인트로 이동. 경유점 지정, 실패 시 정지 / 재시도 / 무시 선택 |
| 대기 (WAIT) | 지정한 시간 동안 대기 |
| 출력 (OUT) | 디지털 출력 ON / OFF |
| 입력 대기 (WAIT IN) | 디지털 입력이 지정한 상태가 될 때까지 대기, 시간 제한 가능 |
| 조건 (IF / ELSE) | 입력·출력·변수 값에 따라 분기 |
| 반복 (LOOP) | 횟수 지정, 무한 반복, 조건이 참인 동안(WHILE) |
| 반복 탈출 (BREAK) | 가장 안쪽 반복을 빠져나감 |
| 변수 (SET) | 변수 대입, 더하기, 빼기 |
| 메시지 (LOG) | 실행 로그에 메시지 기록 |
| Job 호출 (CALL) | 다른 Job을 실행하고 돌아옴 |
| 종료 (END) | Job 종료 |

이동 명령이 있는 Job을 실행하면 해당 맵으로 내비게이션이 자동으로 시작됩니다.

## 디지털 입출력 (I/O)

I/O 는 ROS 토픽으로 연결됩니다. 실제 입출력 장치를 사용하려면 아래 토픽을 처리하는 드라이버 노드가 필요합니다.
드라이버가 없어도 웹 화면에서 입력을 클릭하여 Job을 시험할 수 있습니다.

| 토픽 | 형식 | 방향 |
|---|---|---|
| `/io/digital_out` | `std_msgs/UInt8MultiArray` (8채널, 0 또는 1) | 웹 서버 → 장치 |
| `/io/digital_in` | `std_msgs/UInt8MultiArray` (8채널, 0 또는 1) | 장치 → 웹 서버 |

## 저장 위치

```
~/omorobot_web_data/
├── maps/<맵 이름>/map.pgm, map.yaml     navigation2 에서 그대로 사용 가능한 형식
│                  points.json           위치 포인트
│                  map.orig.pgm          맵 수정 전 원본 (수정한 경우)
├── jobs/<Job 이름>.json
└── settings.json                        가상 키보드 속도, I/O 이름
```

## 안전

- 가상 키보드는 브라우저가 0.5초 동안 명령을 보내지 않으면(연결 끊김, 창 닫힘) 로봇을 정지시킵니다.
- 비상 정지 버튼은 Job, 이동 명령, 수동 조작을 모두 중단합니다. 소프트웨어 정지이므로 하드웨어 비상 정지 스위치를 대신하지 않습니다.
- 로그인 기능이 없습니다. 신뢰할 수 있는 내부 네트워크에서만 사용하세요.

## 구조

| 파일 | 역할 |
|---|---|
| `web_server.py` | Flask 웹 서버, HTTP API |
| `ros_bridge.py` | ROS 노드: 맵·스캔·위치 수신, cmd_vel 발행, navigation2 액션 |
| `orchestrator.py` | bringup / cartographer / navigation2 실행 순서와 전환 |
| `process_manager.py` | `ros2 launch` 프로세스 시작·종료·로그 |
| `job_runner.py` | Job 해석·실행 |
| `nav_tolerance.py` | 정지 위치의 허용 오차에 맞는 controller, behavior tree 선택 |
| `storage.py` | 맵, 포인트, Job, 설정 파일 |
| `tf_reader.py` | tf 수신 (CPU 부하를 줄이기 위한 폴링 방식) |
| `fake_robot.py` | 가상 로봇 (`sim:=true`) |
| `web/` | 브라우저 화면 (외부 라이브러리 없음, 인터넷 연결 불필요) |
