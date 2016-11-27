///<amd-module name="world/Camera"/>
import Kernel = require('./Kernel');
import Utils = require('./Utils');
import MathUtils = require('./math/Math');
import Vertice = require('./math/Vertice');
import Vector = require('./math/Vector');
import Line = require('./math/Line');
import Plan = require('./math/Plan');
import TileGrid = require('./TileGrid');
import Matrix = require('./math/Matrix');
import Object3D = require('./Object3D');

class Camera extends Object3D {
  private readonly initFov: number;
  private readonly animationDuration: number = 600;//层级变化的动画周期是600毫秒
  private readonly nearFactor: number = 0.6;
  private readonly baseTheoryDistanceFromCamera2EarthSurface = 1.23 * Kernel.EARTH_RADIUS;
  private pitch: number;
  private level: number = -1; //当前渲染等级
  private viewMatrix: Matrix;//视点矩阵，即Camera模型矩阵的逆矩阵
  private projMatrix: Matrix;//当Matrix变化的时候，需要重新计算this.far
  private projViewMatrix: Matrix;//获取投影矩阵与视点矩阵的乘积
  private projViewMatrixForDraw: Matrix;//实际传递给shader的矩阵是projViewMatrixForDraw，而不是projViewMatrix
  private animating: boolean = false;

  Enum: any = {
    EARTH_FULL_OVERSPREAD_SCREEN: "EARTH_FULL_OVERSPREAD_SCREEN", //Canvas内全部被地球充满
    EARTH_NOT_FULL_OVERSPREAD_SCREEN: "EARTH_NOT_FULL_OVERSPREAD_SCREEN" //Canvas没有全部被地球充满
  };

  //this.near一旦初始化之后就不应该再修改
  //this.far可以动态计算
  //this.aspect在Viewport改变后重新计算
  //this.fov可以调整以实现缩放效果
  constructor(private fov = 45, private aspect = 1, private near = 1, private far = 100) {
    super();
    this.initFov = this.fov;
    this.pitch = 90;
    this.projMatrix = new Matrix();
    this._rawSetPerspectiveMatrix(this.fov, this.aspect, this.near, this.far);
  }

  private _setPerspectiveMatrix(fov: number = 45, aspect: number = 1, near: number = 1, far: number = 100): void {
    this._rawSetPerspectiveMatrix(fov, aspect, near, far);
    this._updateFar();
  }

  private _rawSetPerspectiveMatrix(fov: number = 45, aspect: number = 1, near: number = 1, far: number = 100): void {
    //https://github.com/toji/gl-matrix/blob/master/src/gl-matrix/mat4.js#L1788
    this.fov = fov;
    this.aspect = aspect;
    this.near = near;
    this.far = far;
    var mat = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ];
    var halfFov = this.fov * Math.PI / 180 / 2;
    var f = 1 / Math.tan(halfFov);
    var nf = 1 / (this.near - this.far);

    mat[0] = f / this.aspect;
    mat[5] = f;
    mat[10] = (this.far + this.near) * nf;
    mat[11] = -1;
    mat[14] = 2 * this.near * this.far * nf;
    mat[15] = 0;

    //by comparision with matrixProjection.exe and glMatrix, the 11th element is always -1
    this.projMatrix.setElements(
      mat[0], mat[1], mat[2], mat[3],
      mat[4], mat[5], mat[6], mat[7],
      mat[8], mat[9], mat[10], mat[11],
      mat[12], mat[13], mat[14], mat[15]
    );
  }

  //更新各种矩阵，保守起见，可以在每帧绘制之前调用
  //理论上只在用户交互的时候调用就可以
  update(): void {
    this.viewMatrix = null;
    //视点矩阵是camera的模型矩阵的逆矩阵
    //this.viewMatrix = this.matrix.getInverseMatrix();

    //通过修改position和fov以更新matrix和projMatrix
    this._updatePositionAndFov();

    //在_updatePositionAndFov()方法调用之后再计算viewMatrix
    this.viewMatrix = this.matrix.getInverseMatrix();

    //最后更新far
    this._updateFar();

    //update projViewMatrix
    this.projViewMatrix = this.projMatrix.multiplyMatrix(this.viewMatrix);
  }

  getPitch(): number{
    var lightDirection = this.getLightDirection();

    return this.pitch;
  }

  setPitch(pitch: number): void{

  }

  getLightDirection(): Vector {
    var dirVertice = this.matrix.getColumnZ();
    var direction = new Vector(-dirVertice.x, -dirVertice.y, -dirVertice.z);
    direction.normalize();
    return direction;
  }

  getDistance2EarthSurface(): number {
    var position = this.getPosition();
    var length2EarthSurface = Vector.fromVertice(position).getLength() - Kernel.EARTH_RADIUS;
    return length2EarthSurface;
  }

  getProjViewMatrixForDraw(): Matrix{
    return this.projViewMatrix;
  }

  private _setFov(fov: number): void {
    if (!(fov > 0)) {
      throw "invalid fov:" + fov;
    }
    this._setPerspectiveMatrix(fov, this.aspect, this.near, this.far);
  }

  setAspect(aspect: number): void {
    if (!(aspect > 0)) {
      throw "invalid aspect:" + aspect;
    }
    this._setPerspectiveMatrix(this.fov, aspect, this.near, this.far);
  }

  private _updateFar(): void {
    //重新计算far,保持far在满足正常需求情况下的最小值
    //far值：视点与地球切面的距离
    var length2EarthOrigin = Vector.fromVertice(this.getPosition()).getLength();
    var far = Math.sqrt(length2EarthOrigin * length2EarthOrigin - Kernel.EARTH_RADIUS * Kernel.EARTH_RADIUS);
    far *= 1.05;
    this._rawSetPerspectiveMatrix(this.fov, this.aspect, this.near, far);
  }

  //计算从第几级level开始不满足视景体的near值
  //比如第10级满足near，第11级不满足near，那么返回10
  private _getSafeThresholdLevelForNear() {
    var thresholdNear = this.near * this.nearFactor;
    var pow2level = this.baseTheoryDistanceFromCamera2EarthSurface / thresholdNear;
    var level = (<any>Math).log2(pow2level);
    return Math.floor(level);
  }

  /**
   * 根据层级计算出摄像机应该放置到距离地球表面多远的位置
   * @param level
   * @return {*}
   */
  private _getTheoryDistanceFromCamera2EarthSurface(level: number): number {
    return this.baseTheoryDistanceFromCamera2EarthSurface / Math.pow(2, level);
  }

  //返回更新后的fov值，如果返回结果 < 0，说明无需更新fov
  private _updatePositionAndFov(): number {
    //是否满足near值，和fov没有关系，和position有关
    //但是改变position的话，fov也要相应变动以满足对应的缩放效果
    const currentLevel = this.getLevel();
    var safeLevel = this._getSafeThresholdLevelForNear();

    //_rawUpdatePositionByLevel()方法会修改this.matrix
    //_setFov()方法会修改this.projMatrix

    if(currentLevel > safeLevel){
      //摄像机距离地球太近，导致不满足视景体的near值,
      //我们需要将摄像机的位置拉远，以满足near值
      this._rawUpdatePositionByLevel(safeLevel);
      //比如safeLevel是10，而currentLevel是11，则deltaLevel为1
      var deltaLevel = currentLevel - safeLevel;
      //摄像机位置与地球表面距离变大之后，我们看到的地球变小，为此，我们需要把fov值变小，以抵消摄像机位置距离增大导致的变化
      //deltaLevel应该为正正数，计算出的newFov应该比this.initFov要小
      var newFov = this._calculateFovByDeltaLevel(this.initFov, deltaLevel);
      this._setFov(newFov);
    }else{
      this._rawUpdatePositionByLevel(currentLevel);
      this._setFov(this.initFov);
    }

    return -1;
  }

  //fov从oldFov变成了newFov，计算相当于缩放了几级level
  //比如从10级缩放到了第11级，fov从30变成了15，即oldFov为30，newFov为15，deltaLevel为1
  //通过Math.log2()计算出结果，所以返回的是小数，可能是正数也可能是负数
  private _calculateDeltaLevelByFov(oldFov: number, newFov: number): number {
    //tan(halfFov) = h / distance，level不同的情况下h不变
    //h1 = l1*tanθ1
    //h2 = l2*tanθ2
    //l2 = l1 * Math.pow(2, deltaLevel)
    //deltaLevel = Math.log2(tanθ1 / tanθ2)
    var radianOldFov = MathUtils.degreeToRadian(oldFov);
    var halfRadianOldFov = radianOldFov / 2;
    var tanOld = Math.tan(halfRadianOldFov);

    var radianNewFov = MathUtils.degreeToRadian(newFov);
    var halfRadianNewFov = radianNewFov / 2;
    var tanNew = Math.tan(halfRadianNewFov);

    var deltaLevel = (<any>Math).log2(tanOld / tanNew);
    return deltaLevel;
  }

  //通过调整fov的值造成层级缩放的效果，比如在第10级的时候，oldFov为正常的30度，当放大到11级的时候，deltaLevel为1，计算出的新的newFov为15度多
  private _calculateFovByDeltaLevel(oldFov: number, deltaLevel: number): number {
    //tan(halfFov) = h / distance，level不同的情况下h不变
    //h1 = l1*tanθ1
    //h2 = l2*tanθ2
    //l2 = l1 * Math.pow(2, deltaLevel)
    var radianOldFov = MathUtils.degreeToRadian(oldFov);
    var halfRadianOldFov = radianOldFov / 2;
    var tanOld = Math.tan(halfRadianOldFov);
    var tanNew = tanOld / Math.pow(2, deltaLevel);
    var halfRadianNewFov = Math.atan(tanNew);
    var radianNewFov = halfRadianNewFov * 2;
    var newFov = MathUtils.radianToDegree(radianNewFov);
    return newFov;
  }

  getLevel(): number {
    return this.level;
  }

  setLevel(level: number): void {
    var isLevelChanged = this._rawUpdatePositionByLevel(level);
    if (isLevelChanged) {
      //不要在this._setLevel()方法中更新this.level，因为这会影响animateToLevel()方法
      this.level = level;
      Kernel.globe.refresh();
    }
  }

  //设置观察到的层级，不要在该方法中修改this.level的值
  private _rawUpdatePositionByLevel(level: number): boolean {
    if (!(Utils.isNonNegativeInteger(level))) {
      throw "invalid level:" + level;
    }
    level = level > Kernel.MAX_LEVEL ? Kernel.MAX_LEVEL : level; //超过最大的渲染级别就不渲染
    if (level === this.level) {
      return false;
    }
    var globe = Kernel.globe;
    var pOld = this.getPosition();
    if (pOld.x === 0 && pOld.y === 0 && pOld.z === 0) {
      //初始设置camera
      var length = this._getTheoryDistanceFromCamera2EarthSurface(level) + Kernel.EARTH_RADIUS; //level等级下摄像机应该到球心的距离
      var origin = new Vertice(0, 0, 0);
      var vector = this.getLightDirection().getOpposite();
      vector.setLength(length);
      var newPosition = vector.getVertice();
      this.look(newPosition, origin);
    } else {
      var length = this._getTheoryDistanceFromCamera2EarthSurface(level) + Kernel.EARTH_RADIUS; //level等级下摄像机应该到球心的距离
      var vector = this.getLightDirection().getOpposite();
      vector.setLength(length);
      var newPosition = vector.getVertice();
      this.setPosition(newPosition.x, newPosition.y, newPosition.z);

      // var distance2SurfaceNow = this._getTheoryDistanceFromCamera2EarthSurface(this.getLevel());
      // var distance2SurfaceNew = this._getTheoryDistanceFromCamera2EarthSurface(level);
      // var deltaDistance = distance2SurfaceNow - distance2SurfaceNew;
      // var dir = this.getLightDirection();
      // dir.setLength(deltaDistance);
      // var pNew = Vector.verticePlusVector(pOld, dir);
      // this.setPosition(pNew.x, pNew.y, pNew.z);
    }
    return true;
  }

  isAnimating(): boolean {
    return this.animating;
  }

  animateToLevel(level: number): void {
    if (!(Utils.isNonNegativeInteger(level))) {
      throw "invalid level:" + level;
    }
    var newCamera = this._clone();
    //don't call setLevel method because it will update CURRENT_LEVEL
    newCamera._rawUpdatePositionByLevel(level);

    this._animateToCamera(newCamera, () => {
      this.level = level;
    });
  }

  private _animateToCamera(newCamera: Camera, cb: () => void) {
    if (this.isAnimating()) {
      return;
    }
    this.animating = true;
    var oldPosition = this.getPosition();
    var newPosition = newCamera.matrix.getPosition();
    var span = this.animationDuration;
    var singleSpan = 1000 / 60;
    var count = Math.floor(span / singleSpan);
    var deltaX = (newPosition.x - oldPosition.x) / count;
    var deltaY = (newPosition.y - oldPosition.y) / count;
    var deltaZ = (newPosition.z - oldPosition.z) / count;
    var start: number = -1;
    var callback = (timestap: number) => {
      if (start < 0) {
        start = timestap;
      }
      var a = timestap - start;
      if (a >= span) {
        (<any>Object).assign(this, newCamera._toJson());
        this.animating = false;
        cb();
      } else {
        var p = this.getPosition();
        this.setPosition(p.x + deltaX, p.y + deltaY, p.z + deltaZ);
        requestAnimationFrame(callback);
      }
    };
    requestAnimationFrame(callback);
  }

  private _clone(): Camera {
    var camera: Camera = new Camera();
    (<any>Object).assign(camera, this._toJson());
    return camera;
  }

  private _toJson(): any {
    return {
      pitch: this.pitch,
      near: this.near,
      far: this.far,
      fov: this.fov,
      aspect: this.aspect,
      matrix: this.matrix.clone(),
      projMatrix: this.projMatrix.clone()
    };
  }

  look(cameraPnt: Vertice, targetPnt: Vertice, upDirection: Vector = new Vector(0, 1, 0)): void {
    var cameraPntCopy = cameraPnt.clone();
    var targetPntCopy = targetPnt.clone();
    var up = upDirection.clone();
    var transX = cameraPntCopy.x;
    var transY = cameraPntCopy.y;
    var transZ = cameraPntCopy.z;
    var zAxis = new Vector(cameraPntCopy.x - targetPntCopy.x, cameraPntCopy.y - targetPntCopy.y, cameraPntCopy.z - targetPntCopy.z).normalize();
    var xAxis = up.cross(zAxis).normalize();
    var yAxis = zAxis.cross(xAxis).normalize();

    this.matrix.setColumnX(xAxis.x, xAxis.y, xAxis.z); //此处相当于对Camera的模型矩阵(不是视点矩阵)设置X轴方向
    this.matrix.setColumnY(yAxis.x, yAxis.y, yAxis.z); //此处相当于对Camera的模型矩阵(不是视点矩阵)设置Y轴方向
    this.matrix.setColumnZ(zAxis.x, zAxis.y, zAxis.z); //此处相当于对Camera的模型矩阵(不是视点矩阵)设置Z轴方向
    this.matrix.setColumnTrans(transX, transY, transZ); //此处相当于对Camera的模型矩阵(不是视点矩阵)设置偏移量
    this.matrix.setLastRowDefault();

    this._updateFar();
  }

  private _lookAt(targetPnt: Vertice, upDirection?: Vector): void {
    var targetPntCopy = targetPnt.clone();
    var position = this.getPosition();
    this.look(position, targetPntCopy, upDirection);
  }

  //根据canvasX和canvasY获取拾取向量
  private _getPickDirectionByCanvas(canvasX: number, canvasY: number): Vector {
    var ndcXY = MathUtils.convertPointFromCanvasToNDC(canvasX, canvasY);
    var pickDirection = this._getPickDirectionByNDC(ndcXY[0], ndcXY[1]);
    return pickDirection;
  }

  //获取当前视线与地球的交点
  getDirectionIntersectPointWithEarth(): Vertice[] {
    var dir = this.getLightDirection();
    var p = this.getPosition();
    var line = new Line(p, dir);
    var result = this.getPickCartesianCoordInEarthByLine(line);
    return result;
  }

  //根据ndcX和ndcY获取拾取向量
  private _getPickDirectionByNDC(ndcX: number, ndcY: number): Vector {
    var verticeInNDC = new Vertice(ndcX, ndcY, 0.499);
    var verticeInWorld = this._convertVerticeFromNdcToWorld(verticeInNDC);
    var cameraPositon = this.getPosition(); //摄像机的世界坐标
    var pickDirection = Vector.verticeMinusVertice(verticeInWorld, cameraPositon);
    pickDirection.normalize();
    return pickDirection;
  }

  //获取直线与地球的交点，该方法与MathUtils.getLineIntersectPointWithEarth功能基本一样，只不过该方法对相交点进行了远近排序
  getPickCartesianCoordInEarthByLine(line: Line): Vertice[] {
    var result: Vertice[] = [];
    //pickVertice是笛卡尔空间直角坐标系中的坐标
    var pickVertices = MathUtils.getLineIntersectPointWithEarth(line);
    if (pickVertices.length === 0) {
      //没有交点
      result = [];
    } else if (pickVertices.length == 1) {
      //一个交点
      result = pickVertices;
    } else if (pickVertices.length == 2) {
      //两个交点
      var pickVerticeA = pickVertices[0];
      var pickVerticeB = pickVertices[1];
      var cameraVertice = this.getPosition();
      var lengthA = MathUtils.getLengthFromVerticeToVertice(cameraVertice, pickVerticeA);
      var lengthB = MathUtils.getLengthFromVerticeToVertice(cameraVertice, pickVerticeB);
      //将距离人眼更近的那个点放到前面
      result = lengthA <= lengthB ? [pickVerticeA, pickVerticeB] : [pickVerticeB, pickVerticeA];
    }
    return result;
  }

  //计算拾取射线与地球的交点，以笛卡尔空间直角坐标系坐标数组的形式返回
  getPickCartesianCoordInEarthByCanvas(canvasX: number, canvasY: number): Vertice[] {
    var pickDirection = this._getPickDirectionByCanvas(canvasX, canvasY);
    var p = this.getPosition();
    var line = new Line(p, pickDirection);
    var result = this.getPickCartesianCoordInEarthByLine(line);
    return result;
  }

  private _getPickCartesianCoordInEarthByNDC(ndcX: number, ndcY: number): Vertice[] {
    var pickDirection = this._getPickDirectionByNDC(ndcX, ndcY);
    var p = this.getPosition();
    var line = new Line(p, pickDirection);
    var result = this.getPickCartesianCoordInEarthByLine(line);
    return result;
  }

  //得到摄像机的XOZ平面的方程
  private _getPlanXOZ(): Plan {
    var position = this.getPosition();
    var direction = this.getLightDirection();
    var plan = MathUtils.getCrossPlaneByLine(position, direction);
    return plan;
  }

  //点变换: World->NDC
  private _convertVerticeFromWorldToNDC(verticeInWorld: Vertice): Vertice {
    var columnWorld = [verticeInWorld.x, verticeInWorld.y, verticeInWorld.z, 1];
    var columnProject = this.projViewMatrix.multiplyColumn(columnWorld);
    var w = columnProject[3];
    var columnNDC: number[] = [];
    columnNDC[0] = columnProject[0] / w;
    columnNDC[1] = columnProject[1] / w;
    columnNDC[2] = columnProject[2] / w;
    columnNDC[3] = 1;
    var verticeInNDC = new Vertice(columnNDC[0], columnNDC[1], columnNDC[2]);
    return verticeInNDC;
  }

  //点变换: NDC->World
  private _convertVerticeFromNdcToWorld(verticeInNDC: Vertice): Vertice {
    var columnNDC: number[] = [verticeInNDC.x, verticeInNDC.y, verticeInNDC.z, 1]; //NDC归一化坐标
    var inverseProj = this.projMatrix.getInverseMatrix(); //投影矩阵的逆矩阵
    var columnCameraTemp = inverseProj.multiplyColumn(columnNDC); //带引号的“视坐标”
    var cameraX = columnCameraTemp[0] / columnCameraTemp[3];
    var cameraY = columnCameraTemp[1] / columnCameraTemp[3];
    var cameraZ = columnCameraTemp[2] / columnCameraTemp[3];
    var cameraW = 1;
    var columnCamera = [cameraX, cameraY, cameraZ, cameraW]; //真实的视坐标
    var columnWorld = this.matrix.multiplyColumn(columnCamera); //单击点的世界坐标
    var verticeInWorld = new Vertice(columnWorld[0], columnWorld[1], columnWorld[2]);
    return verticeInWorld;
  }

  //点变换: Camera->World
  private _convertVerticeFromCameraToWorld(verticeInCamera: Vertice): Vertice {
    var verticeInCameraCopy = verticeInCamera.clone();
    var column = [verticeInCameraCopy.x, verticeInCameraCopy.y, verticeInCameraCopy.z, 1];
    var column2 = this.matrix.multiplyColumn(column);
    var verticeInWorld = new Vertice(column2[0], column2[1], column2[2]);
    return verticeInWorld;
  }

  //向量变换: Camera->World
  private _convertVectorFromCameraToWorld(vectorInCamera: Vector): Vector {
    var vectorInCameraCopy = vectorInCamera.clone();
    var verticeInCamera = vectorInCameraCopy.getVertice();
    var verticeInWorld = this._convertVerticeFromCameraToWorld(verticeInCamera);
    var originInWorld = this.getPosition();
    var vectorInWorld = Vector.verticeMinusVertice(verticeInWorld, originInWorld);
    vectorInWorld.normalize();
    return vectorInWorld;
  }

  //判断世界坐标系中的点是否在Canvas中可见
  //options: verticeInNDC,threshold
  private _isWorldVerticeVisibleInCanvas(verticeInWorld: Vertice, options: any = {}): boolean {
    var threshold = typeof options.threshold == "number" ? Math.abs(options.threshold) : 1;
    var cameraP = this.getPosition();
    var dir = Vector.verticeMinusVertice(verticeInWorld, cameraP);
    var line = new Line(cameraP, dir);
    var pickResult = this.getPickCartesianCoordInEarthByLine(line);
    if (pickResult.length > 0) {
      var pickVertice = pickResult[0];
      var length2Vertice = MathUtils.getLengthFromVerticeToVertice(cameraP, verticeInWorld);
      var length2Pick = MathUtils.getLengthFromVerticeToVertice(cameraP, pickVertice);
      if (length2Vertice < length2Pick + 5) {
        if (!(options.verticeInNDC instanceof Vertice)) {
          options.verticeInNDC = this._convertVerticeFromWorldToNDC(verticeInWorld);
        }
        var result = options.verticeInNDC.x >= -1 && options.verticeInNDC.x <= 1 && options.verticeInNDC.y >= -threshold && options.verticeInNDC.y <= 1;
        return result;
      }
    }
    return false;
  }

  //判断地球表面的某个经纬度在Canvas中是否应该可见
  //options: verticeInNDC
  private _isGeoVisibleInCanvas(lon: number, lat: number, options?: any): boolean {
    var verticeInWorld = MathUtils.geographicToCartesianCoord(lon, lat);
    var result = this._isWorldVerticeVisibleInCanvas(verticeInWorld, options);
    return result;
  }

  /**
   * 算法，一个切片需要渲染需要满足如下三个条件:
   * 1.至少要有一个点在Canvas中可见
   * 2.NDC面积足够大
   * 3.形成的NDC四边形是顺时针方向
   */
  //获取level层级下的可见切片
  //options:
  getVisibleTilesByLevel(level: number, options: any = {}): TileGrid[] {
    if (!(level >= 0)) {
      throw "invalid level";
    }
    var result: TileGrid[] = [];
    //向左、向右、向上、向下最大的循环次数
    var LOOP_LIMIT = Math.min(10, Math.pow(2, level) - 1);

    var mathOptions = {
      maxSize: Math.pow(2, level)
    };

    function checkVisible(visibleInfo: any) {
      if (visibleInfo.area >= 5000 && visibleInfo.clockwise) {
        if (visibleInfo.visibleCount >= 1) {
          return true;
        }
      }
      return false;
    }

    //处理一整行
    function handleRow(centerRow: number, centerColumn: number): TileGrid[] {
      var result: TileGrid[] = [];
      var grid = new TileGrid(level, centerRow, centerColumn); // {level:level,row:centerRow,column:centerColumn};
      var visibleInfo = this._getTileVisibleInfo(grid.level, grid.row, grid.column, options);
      var isRowCenterVisible = checkVisible(visibleInfo);
      if (isRowCenterVisible) {
        (grid as any).visibleInfo = visibleInfo;
        result.push(grid);

        //向左遍历至不可见
        var leftLoopTime = 0; //向左循环的次数
        var leftColumn = centerColumn;
        var visible: boolean;
        while (leftLoopTime < LOOP_LIMIT) {
          leftLoopTime++;
          grid = TileGrid.getTileGridByBrother(level, centerRow, leftColumn, MathUtils.LEFT, mathOptions);
          leftColumn = grid.column;
          visibleInfo = this._getTileVisibleInfo(grid.level, grid.row, grid.column, options);
          visible = checkVisible(visibleInfo);
          if (visible) {
            (<any>grid).visibleInfo = visibleInfo;
            result.push(grid);
          } else {
            break;
          }
        }

        //向右遍历至不可见
        var rightLoopTime = 0; //向右循环的次数
        var rightColumn = centerColumn;
        while (rightLoopTime < LOOP_LIMIT) {
          rightLoopTime++;
          grid = TileGrid.getTileGridByBrother(level, centerRow, rightColumn, MathUtils.RIGHT, mathOptions);
          rightColumn = grid.column;
          visibleInfo = this._getTileVisibleInfo(grid.level, grid.row, grid.column, options);
          visible = checkVisible(visibleInfo);
          if (visible) {
            (<any>grid).visibleInfo = visibleInfo;
            result.push(grid);
          } else {
            break;
          }
        }
      }
      return result;
    }

    var verticalCenterInfo = this._getVerticalVisibleCenterInfo();
    var centerGrid = TileGrid.getTileGridByGeo(verticalCenterInfo.lon, verticalCenterInfo.lat, level);
    var handleRowThis = handleRow.bind(this);

    var rowResult = handleRowThis(centerGrid.row, centerGrid.column);
    result = result.concat(rowResult);
    var grid: TileGrid;

    //循环向下处理至不可见
    var bottomLoopTime = 0; //向下循环的次数
    var bottomRow = centerGrid.row;
    while (bottomLoopTime < LOOP_LIMIT) {
      bottomLoopTime++;
      grid = TileGrid.getTileGridByBrother(level, bottomRow, centerGrid.column, MathUtils.BOTTOM, mathOptions);
      bottomRow = grid.row;
      rowResult = handleRowThis(grid.row, grid.column);
      if (rowResult.length > 0) {
        result = result.concat(rowResult);
      } else {
        //已经向下循环到不可见，停止向下循环
        break;
      }
    }

    //循环向上处理至不可见
    var topLoopTime = 0; //向上循环的次数
    var topRow = centerGrid.row;
    while (topLoopTime < LOOP_LIMIT) {
      topLoopTime++;
      grid = TileGrid.getTileGridByBrother(level, topRow, centerGrid.column, MathUtils.TOP, mathOptions);
      topRow = grid.row;
      rowResult = handleRowThis(grid.row, grid.column);
      if (rowResult.length > 0) {
        result = result.concat(rowResult);
      } else {
        //已经向上循环到不可见，停止向上循环
        break;
      }
    }

    return result;
  }

  //options: threshold
  private _getTileVisibleInfo(level: number, row: number, column: number, options: any = {}): any {
    if (!(level >= 0)) {
      throw "invalid level";
    }
    if (!(row >= 0)) {
      throw "invalid row";
    }
    if (!(column >= 0)) {
      throw "invalid column";
    }

    var threshold = typeof options.threshold == "number" ? Math.abs(options.threshold) : 1;
    var result: any = {
      lb: {
        lon: null,
        lat: null,
        verticeInWorld: null,
        verticeInNDC: null,
        visible: false
      },
      lt: {
        lon: null,
        lat: null,
        verticeInWorld: null,
        verticeInNDC: null,
        visible: false
      },
      rt: {
        lon: null,
        lat: null,
        verticeInWorld: null,
        verticeInNDC: null,
        visible: false
      },
      rb: {
        lon: null,
        lat: null,
        verticeInWorld: null,
        verticeInNDC: null,
        visible: false
      },
      Egeo: null,
      visibleCount: 0,
      clockwise: false,
      width: null,
      height: null,
      area: null
    };

    result.Egeo = MathUtils.getTileGeographicEnvelopByGrid(level, row, column);
    var tileMinLon = result.Egeo.minLon;
    var tileMaxLon = result.Egeo.maxLon;
    var tileMinLat = result.Egeo.minLat;
    var tileMaxLat = result.Egeo.maxLat;

    //左下角
    result.lb.lon = tileMinLon;
    result.lb.lat = tileMinLat;
    result.lb.verticeInWorld = MathUtils.geographicToCartesianCoord(result.lb.lon, result.lb.lat);
    result.lb.verticeInNDC = this._convertVerticeFromWorldToNDC(result.lb.verticeInWorld);
    result.lb.visible = this._isWorldVerticeVisibleInCanvas(result.lb.verticeInWorld, {
      verticeInNDC: result.lb.verticeInNDC,
      threshold: threshold
    });
    if (result.lb.visible) {
      result.visibleCount++;
    }

    //左上角
    result.lt.lon = tileMinLon;
    result.lt.lat = tileMaxLat;
    result.lt.verticeInWorld = MathUtils.geographicToCartesianCoord(result.lt.lon, result.lt.lat);
    result.lt.verticeInNDC = this._convertVerticeFromWorldToNDC(result.lt.verticeInWorld);
    result.lt.visible = this._isWorldVerticeVisibleInCanvas(result.lt.verticeInWorld, {
      verticeInNDC: result.lt.verticeInNDC,
      threshold: threshold
    });
    if (result.lt.visible) {
      result.visibleCount++;
    }

    //右上角
    result.rt.lon = tileMaxLon;
    result.rt.lat = tileMaxLat;
    result.rt.verticeInWorld = MathUtils.geographicToCartesianCoord(result.rt.lon, result.rt.lat);
    result.rt.verticeInNDC = this._convertVerticeFromWorldToNDC(result.rt.verticeInWorld);
    result.rt.visible = this._isWorldVerticeVisibleInCanvas(result.rt.verticeInWorld, {
      verticeInNDC: result.rt.verticeInNDC,
      threshold: threshold
    });
    if (result.rt.visible) {
      result.visibleCount++;
    }

    //右下角
    result.rb.lon = tileMaxLon;
    result.rb.lat = tileMinLat;
    result.rb.verticeInWorld = MathUtils.geographicToCartesianCoord(result.rb.lon, result.rb.lat);
    result.rb.verticeInNDC = this._convertVerticeFromWorldToNDC(result.rb.verticeInWorld);
    result.rb.visible = this._isWorldVerticeVisibleInCanvas(result.rb.verticeInWorld, {
      verticeInNDC: result.rb.verticeInNDC,
      threshold: threshold
    });
    if (result.rb.visible) {
      result.visibleCount++;
    }

    var ndcs: Vertice[] = [result.lb.verticeInNDC, result.lt.verticeInNDC, result.rt.verticeInNDC, result.rb.verticeInNDC];
    //计算方向
    var vector03 = Vector.verticeMinusVertice(ndcs[3], ndcs[0]);
    vector03.z = 0;
    var vector01 = Vector.verticeMinusVertice(ndcs[1], ndcs[0]);
    vector01.z = 0;
    var cross = vector03.cross(vector01);
    result.clockwise = cross.z > 0;
    //计算面积
    var topWidth = Math.sqrt(Math.pow(ndcs[1].x - ndcs[2].x, 2) + Math.pow(ndcs[1].y - ndcs[2].y, 2)) * Kernel.canvas.width / 2;
    var bottomWidth = Math.sqrt(Math.pow(ndcs[0].x - ndcs[3].x, 2) + Math.pow(ndcs[0].y - ndcs[3].y, 2)) * Kernel.canvas.width / 2;
    result.width = Math.floor((topWidth + bottomWidth) / 2);
    var leftHeight = Math.sqrt(Math.pow(ndcs[0].x - ndcs[1].x, 2) + Math.pow(ndcs[0].y - ndcs[1].y, 2)) * Kernel.canvas.height / 2;
    var rightHeight = Math.sqrt(Math.pow(ndcs[2].x - ndcs[3].x, 2) + Math.pow(ndcs[2].y - ndcs[3].y, 2)) * Kernel.canvas.height / 2;
    result.height = Math.floor((leftHeight + rightHeight) / 2);
    result.area = result.width * result.height;

    return result;
  }

  //地球一直是关于纵轴中心对称的，获取垂直方向上中心点信息
  private _getVerticalVisibleCenterInfo(): any {
    var result = {
      ndcY: <number>null,
      pIntersect: <Vertice>null,
      lon: <number>null,
      lat: <number>null
    };
    var pickResults: Vertice[];
    if (this.pitch == 90) {
      result.ndcY = 0;
    } else {
      var count = 10;
      var delta = 2.0 / count;
      var topNdcY = 1;
      var bottomNdcY = -1;
      var ndcY: number;
      //从上往下找topNdcY
      for (ndcY = 1.0; ndcY >= -1.0; ndcY -= delta) {
        pickResults = this._getPickCartesianCoordInEarthByNDC(0, ndcY);
        if (pickResults.length > 0) {
          topNdcY = ndcY;
          break;
        }
      }

      //从下往上找
      for (ndcY = -1.0; ndcY <= 1.0; ndcY += delta) {
        pickResults = this._getPickCartesianCoordInEarthByNDC(0, ndcY);
        if (pickResults.length > 0) {
          bottomNdcY = ndcY;
          break;
        }
      }
      result.ndcY = (topNdcY + bottomNdcY) / 2;
    }
    pickResults = this._getPickCartesianCoordInEarthByNDC(0, result.ndcY);
    result.pIntersect = pickResults[0];
    var lonlat = MathUtils.cartesianCoordToGeographic(result.pIntersect);
    result.lon = lonlat[0];
    result.lat = lonlat[1];
    return result;
  }
}

export = Camera;